const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const puppeteer = require('puppeteer-core')

const CHROME_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const profilesRoot = path.join(app.getPath('userData'), 'chrome-profiles')
const campaignJobs = new Map()

let mainWindow

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const randomId = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const bytes = crypto.randomBytes(10)

  return Array.from({ length: 10 }, (_value, index) =>
    alphabet[bytes[index] % alphabet.length]
  ).join('')
}

function getRecipientValue(row, key) {
  const requestedKey = key.toLowerCase()
  const entry = Object.entries(row || {}).find(
    ([name]) => name.trim().toLowerCase() === requestedKey
  )

  return String(entry?.[1] || '').trim()
}

function createTemplateContext(row) {
  const email = getRecipientValue(row, 'email')
  const name =
    getRecipientValue(row, 'name') ||
    email.split('@')[0].replace(/[._-]+/g, ' ').trim()
  const randomNames = [
    'Aarav Sharma',
    'Ananya Patel',
    'Rohan Mehta',
    'Priya Kapoor',
    'Kabir Verma',
  ]
  const spanishNames = [
    'Lucía García',
    'Mateo Rodríguez',
    'Sofía Martínez',
    'Diego Fernández',
    'Elena Torres',
  ]
  return {
    email,
    name,
    random_name:
      randomNames[crypto.randomInt(0, randomNames.length)] || randomNames[0],
    spanish_name:
      spanishNames[crypto.randomInt(0, spanishNames.length)] ||
      spanishNames[0],
    date: new Intl.DateTimeFormat('en-IN', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(new Date()),
    id: randomId(),
  }
}

function expandTemplate(template, row, context = createTemplateContext(row)) {
  return String(template || '').replace(/\{\{([^}]+)\}\}/g, (match, key) => {
    const normalizedKey = String(key).trim().toLowerCase()
    return Object.prototype.hasOwnProperty.call(context, normalizedKey)
      ? context[normalizedKey]
      : getRecipientValue(row, normalizedKey) || match
  })
}

async function connectToGmail(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/version`)

  if (!response.ok) {
    throw new Error('Chrome profile is not running.')
  }

  const info = await response.json()
  const browser = await puppeteer.connect({
    browserWSEndpoint: info.webSocketDebuggerUrl,
    defaultViewport: null,
  })
  const pages = await browser.pages()
  let page = pages.find((candidate) =>
    candidate.url().includes('mail.google.com')
  )

  if (!page) {
    page = pages[0] || (await browser.newPage())
    await page.goto('https://mail.google.com/mail/u/0/#inbox', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
  }

  await page.bringToFront()
  await page.waitForSelector(
    '[gh="cm"], [aria-label="Compose"], [role="button"][aria-label="Compose"]',
    { visible: true, timeout: 30000 }
  )

  return { browser, page }
}

async function waitForAttachmentUpload(page) {
  await page.waitForFunction(
    () => {
      const visible = (element) => {
        const style = window.getComputedStyle(element)
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getBoundingClientRect().width > 0 &&
          element.getBoundingClientRect().height > 0
        )
      }

      const uploadStillRunning = Array.from(
        document.querySelectorAll(
          '[role="progressbar"], [aria-label*="Uploading" i], [aria-label*="uploading" i]'
        )
      ).some(visible)

      // Gmail renders a remove-attachment control only after the attachment
      // has been accepted into the compose window. This avoids depending on
      // the visible filename, which can be truncated or localized.
      const attachmentReady = Array.from(
        document.querySelectorAll(
          '[aria-label*="Remove attachment" i], [data-tooltip*="Remove attachment" i], [title*="Remove attachment" i], .aA6'
        )
      ).some(visible)

      return attachmentReady && !uploadStillRunning
    },
    { timeout: 30000 }
  )
}

async function clickGmailSend(page) {
  const sendSelectors = [
    'div[role="button"][aria-label^="Send"]',
    'button[aria-label*="Send" i]',
    '[aria-label^="Send"]',
    '[data-tooltip^="Send"]',
    '[command="send"]',
    '.gU.Up',
  ]

  const selector = sendSelectors.join(', ')

  const sendReady = await page
    .waitForFunction(
      (sendSelector) => {
        const visible = (element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0
          )
        }

        return Array.from(document.querySelectorAll(sendSelector)).some(
          (element) =>
            visible(element) &&
            element.getAttribute('aria-disabled') !== 'true' &&
            !element.disabled
        )
      },
      { timeout: 12000 },
      selector
    )
    .then(() => true)
    .catch(() => false)

  if (!sendReady) return false

  await page.evaluate((sendSelector) => {
    const visible = (element) => {
      const style = window.getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }

    const button = Array.from(document.querySelectorAll(sendSelector)).find(
      (element) =>
        visible(element) &&
        element.getAttribute('aria-disabled') !== 'true' &&
        !element.disabled
    )

    if (!button) return
    button.scrollIntoView({ block: 'center', inline: 'center' })
    button.click()
  }, selector)

  return true
}

async function sendOneEmail(page, payload, row, attachmentPath) {
  const email = getRecipientValue(row, 'email')

  if (!email) {
    throw new Error('This CSV row does not contain an email address.')
  }

  const context = createTemplateContext(row)
  const expandedSubject = expandTemplate(payload.subject, row, context)
  const body = expandTemplate(payload.body, row, context)
  const typingDelay = Math.max(Number(payload.typingDelayMs) || 0, 0)
  const composeButton = await page.waitForSelector(
    '[gh="cm"], [aria-label="Compose"], [role="button"][aria-label="Compose"]',
    { visible: true, timeout: 15000 }
  )

  await composeButton.click()

  if (attachmentPath) {
    // Prefer the hidden input when Gmail has already rendered it. If Gmail
    // only creates it after the paperclip click, intercept the native chooser
    // before clicking so macOS never shows a blocking file-picker window.
    const fileInput = await page
      .waitForSelector('input[type="file"]', { timeout: 3000 })
      .catch(() => null)

    if (fileInput) {
      await fileInput.uploadFile(attachmentPath)
    } else {
      const attachmentButton = await page.waitForSelector(
        '[command="Files"], [aria-label*="Attach"], .a1.aaA.aMZ',
        { visible: true, timeout: 15000 }
      )
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser(),
        attachmentButton.click(),
      ])
      await fileChooser.accept([attachmentPath])
    }

    // Do not fill recipient, subject, or body until Gmail shows the
    // attachment chip and no upload progress indicator remains.
    await waitForAttachmentUpload(page)
  }

  const recipientInput = await page.waitForSelector(
    'input[aria-label="To recipients"], input[role="combobox"][aria-autocomplete="list"]',
    { visible: true, timeout: 15000 }
  )
  await recipientInput.click()
  await recipientInput.type(email, { delay: typingDelay })
  await page.keyboard.press('Enter')

  const subjectInput = await page.waitForSelector('input[name="subjectbox"]', {
    visible: true,
    timeout: 15000,
  })
  await subjectInput.click()
  await subjectInput.type(expandedSubject, { delay: typingDelay })

  const messageBody = await page.waitForSelector(
    '[aria-label="Message Body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]',
    { visible: true, timeout: 15000 }
  )
  await messageBody.click()

  if (payload.htmlMode) {
    await messageBody.evaluate((element, html) => {
      element.innerHTML = html
      element.dispatchEvent(new InputEvent('input', { bubbles: true }))
    }, body)
  } else {
    await messageBody.type(body, { delay: typingDelay })
  }

  const clickedSendButton = await clickGmailSend(page)

  if (!clickedSendButton) {
    // Gmail exposes send as Meta+Enter on macOS. This fallback also handles
    // compose variants where the toolbar button has no stable aria label.
    await page.keyboard.press('Meta+Enter')
  }

  const composeClosed = await page
    .waitForSelector('input[name="subjectbox"]', {
      hidden: true,
      timeout: 3000,
    })
    .then(() => true)
    .catch(() => false)

  if (!composeClosed && clickedSendButton) {
    // The toolbar can be visible before Gmail is ready to accept the click.
    await page.keyboard.press('Meta+Enter')
  }

  const sent = await page
    .waitForSelector('input[name="subjectbox"]', {
      hidden: true,
      timeout: 3000,
    })
    .then(() => true)
    .catch(() => false)

  if (!sent) {
    throw new Error('Gmail did not close the compose window after Send.')
  }

  await wait(800)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

ipcMain.handle('start-profile', async (_event, port) => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)

    if (!response.ok) {
      throw new Error('Chrome profile is not running.')
    }

    const info = await response.json()

    const browser = await puppeteer.connect({
      browserWSEndpoint: info.webSocketDebuggerUrl,
      defaultViewport: null,
    })

    const pages = await browser.pages()

    let page = pages.find((p) =>
      p.url().includes('google.com') ||
      p.url().includes('gmail.com')
    )

    if (!page) {
      page = pages[0] || await browser.newPage()
    }

    await page.bringToFront()

    return {
      success: true,
      port,
      browser: info.Browser || 'Chrome',
      message: 'Chrome profile connected.',
    }
  } catch (error) {
    console.error('[Automation] Connection failed:', error)

    return {
      success: false,
      error: 'Open this Chrome profile first, then click Start.',
    }
  }
})

ipcMain.handle('run-campaign', async (_event, payload) => {
  const campaignId = String(payload?.campaignId || '')
  const job = {
    cancelled: false,
  }

  if (!campaignId) {
    return { success: false, error: 'Campaign ID is required.' }
  }

  if (campaignJobs.has(campaignId)) {
    return { success: false, error: 'This campaign is already running.' }
  }

  campaignJobs.set(campaignId, job)

  let browser
  let attachmentPath
  let attachmentDirectory
  let sent = Number(payload.baseSent) || 0
  let failed = Number(payload.baseFailed) || 0
  let processed = 0
  const recipients = Array.isArray(payload.recipients)
    ? payload.recipients
    : []
  const startIndex = Number(payload.startIndex) || 0
  const totalRecipients = Number(payload.totalRecipients) || recipients.length

  const emitProgress = (progress) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('campaign-progress', {
      campaignId: payload.campaignId,
      profileId: payload.profileId,
      ...progress,
    })
  }

  try {
    if (!recipients.length) {
      throw new Error('The campaign CSV does not contain any recipients.')
    }

    if (payload.attachment?.data) {
      // Keep the uploaded file's original basename so Gmail displays the
      // filename the user selected. Isolation comes from the unique temp
      // directory, not from changing the visible filename.
      attachmentDirectory = fs.mkdtempSync(
        path.join(app.getPath('temp'), 'mail-system-')
      )
      const originalName =
        path.basename(payload.attachment.name || 'attachment') || 'attachment'
      attachmentPath = path.join(attachmentDirectory, originalName)
      fs.writeFileSync(
        attachmentPath,
        Buffer.from(new Uint8Array(payload.attachment.data))
      )
    }

    const connection = await connectToGmail(payload.port)
    browser = connection.browser

    for (const row of recipients) {
      if (job.cancelled) {
        emitProgress({
          status: 'Paused',
          sent,
          failed,
          pending: Math.max(totalRecipients - startIndex - processed, 0),
          nextRecipientIndex: startIndex + processed,
        })
        return { success: false, cancelled: true, sent, failed }
      }

      const email = getRecipientValue(row, 'email')

      try {
        await sendOneEmail(connection.page, payload, row, attachmentPath)
        sent += 1
        processed += 1
        emitProgress({
          status: 'Running',
          sent,
          failed,
          pending: Math.max(totalRecipients - startIndex - processed, 0),
          nextRecipientIndex: startIndex + processed,
          recipientEmail: email,
        })
      } catch (error) {
        failed += 1
        processed += 1
        emitProgress({
          status: 'Running',
          sent,
          failed,
          pending: Math.max(totalRecipients - startIndex - processed, 0),
          nextRecipientIndex: startIndex + processed,
          recipientEmail: email,
          error: error.message,
        })
      }

      if (payload.delaySeconds > 0 && processed < recipients.length) {
        await wait(Number(payload.delaySeconds) * 1000)
      }
    }

    emitProgress({
      status:
        failed > (Number(payload.baseFailed) || 0) && sent === (Number(payload.baseSent) || 0)
          ? 'Failed'
          : 'Completed',
      sent,
      failed,
      pending: Math.max(totalRecipients - startIndex - processed, 0),
      nextRecipientIndex: startIndex + processed,
    })

    return { success: true, sent, failed }
  } catch (error) {
    emitProgress({
      status: 'Failed',
      sent,
      failed,
      pending: Math.max(totalRecipients - startIndex - processed, 0),
      nextRecipientIndex: startIndex + processed,
      error: error.message,
    })

    return { success: false, error: error.message, sent, failed }
  } finally {
    campaignJobs.delete(campaignId)
    if (browser) browser.disconnect()
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      fs.unlinkSync(attachmentPath)
    }
    if (attachmentDirectory && fs.existsSync(attachmentDirectory)) {
      fs.rmdirSync(attachmentDirectory)
    }
  }
})

ipcMain.handle('stop-campaign', async (_event, campaignId) => {
  const job = campaignJobs.get(String(campaignId))

  if (!job) return { success: false, error: 'Campaign is not running.' }

  job.cancelled = true
  return { success: true }
})

ipcMain.handle('open-chrome-profile', async (_event, profileId, port) => {
  try {
    if (!fs.existsSync(CHROME_PATH)) {
      throw new Error('Google Chrome not found.')
    }

    fs.mkdirSync(profilesRoot, { recursive: true })

    const profileDir = path.join(
      profilesRoot,
      `profile-${String(profileId)}`
    )

    fs.mkdirSync(profileDir, { recursive: true })

    // Unique debugging port for each profile.
    const debugPort = Number(port) || 9222

    const chrome = spawn(CHROME_PATH, [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${debugPort}`,
      '--no-first-run',
      '--no-default-browser-check',
      'https://accounts.google.com/v3/signin/identifier?continue=https://www.google.com/&ec=futura_exp_og_so_72776762_e&hl=en&passive=true&flowName=GlifWebSignIn&flowEntry=ServiceLogin',
    ], {
      detached: true,
      stdio: 'ignore',
    })

    chrome.unref()

    return {
      success: true,
      profileId,
      port: debugPort,
    }
  } catch (error) {
    console.error('[Chrome] Launch failed:', error)

    return {
      success: false,
      error: error.message,
    }
  }
})

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
