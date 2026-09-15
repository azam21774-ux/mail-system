const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const puppeteer = require('puppeteer-core')
const ExcelJS = require('exceljs')
const { Document, ImageRun, Packer, Paragraph } = require('docx')
const PptxGenJS = require('pptxgenjs')

const CHROME_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const profilesRoot = path.join(app.getPath('userData'), 'chrome-profiles')
const campaignJobs = new Map()

let mainWindow

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

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
    'James Anderson',
    'Emily Carter',
    'Michael Brooks',
    'Olivia Bennett',
    'Daniel Parker',
    'Sophia Mitchell',
    'William Turner',
    'Ava Collins',
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

function looksLikeHtml(value) {
  return /<\s*\/?\s*[a-z][^>]*>/i.test(String(value || ''))
}

function createStandaloneHtml(source) {
  const html = String(source || '').trim()
  const rendererResetStyle = `
    <style id="mail-system-render-reset">
      html, body {
        margin: 0 !important;
        padding: 0 !important;
      }
    </style>
  `

  if (/<html[\s>]/i.test(html)) {
    return html.replace(/<\/head>/i, `${rendererResetStyle}</head>`)
  }

  return `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${rendererResetStyle}
  </head>
  <body>${html}</body>
</html>`
}

function trimScreenshotToContent(screenshot, renderScale) {
  const size = screenshot.getSize()
  const bitmap = screenshot.getBitmap()

  if (!size.width || !size.height || !bitmap?.length) {
    return {
      image: screenshot,
      width: size.width,
      height: size.height,
    }
  }

  const background = [bitmap[0], bitmap[1], bitmap[2], bitmap[3]]
  const threshold = 12
  const isContentPixel = (offset) =>
    Math.max(
      Math.abs(bitmap[offset] - background[0]),
      Math.abs(bitmap[offset + 1] - background[1]),
      Math.abs(bitmap[offset + 2] - background[2]),
      Math.abs(bitmap[offset + 3] - background[3])
    ) > threshold

  let left = size.width
  let top = size.height
  let right = -1
  let bottom = -1

  for (let y = 0; y < size.height; y += 1) {
    for (let x = 0; x < size.width; x += 1) {
      const offset = (y * size.width + x) * 4
      if (!isContentPixel(offset)) continue
      left = Math.min(left, x)
      top = Math.min(top, y)
      right = Math.max(right, x)
      bottom = Math.max(bottom, y)
    }
  }

  if (right < left || bottom < top) {
    return {
      image: screenshot,
      width: size.width,
      height: size.height,
    }
  }

  const padding = Math.max(Math.round(renderScale), 1)
  const cropX = Math.max(left - padding, 0)
  const cropY = Math.max(top - padding, 0)
  const cropRight = Math.min(right + padding + 1, size.width)
  const cropBottom = Math.min(bottom + padding + 1, size.height)

  return {
    image: screenshot.crop({
      x: cropX,
      y: cropY,
      width: cropRight - cropX,
      height: cropBottom - cropY,
    }),
    width: cropRight - cropX,
    height: cropBottom - cropY,
  }
}

async function renderHtmlAsset({
  html,
  type,
  targetDisplayWidth = null,
  targetDisplayHeight = null,
  trimToContent = true,
}) {
  const renderWindow = new BrowserWindow({
    show: false,
    width: 1200,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  })

  try {
    await renderWindow.loadURL(
      `data:text/html;charset=UTF-8,${encodeURIComponent(
        createStandaloneHtml(html)
      )}`
    )

    await renderWindow.webContents.executeJavaScript(`
      (async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        await Promise.all(
          Array.from(document.images).map((image) => {
            if (image.complete) return Promise.resolve();
            return new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            });
          })
        );

        const resetBox = (element) => {
          if (!element) return;
          element.style.setProperty('margin', '0', 'important');
          element.style.setProperty('padding', '0', 'important');
          element.style.setProperty('background-color', '#ffffff', 'important');
        };

        resetBox(document.documentElement);
        resetBox(document.body);
        resetBox(document.body?.firstElementChild);

        return true;
      })()
    `)

    if (type === 'pdf') {
      return {
        success: true,
        data: await renderWindow.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          pageSize: 'A4',
          margins: {
            marginType: 'custom',
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
          },
        }),
        mimeType: 'application/pdf',
      }
    }

    if (type === 'png' || type === 'jpeg') {
      const dimensions = await renderWindow.webContents.executeJavaScript(`
        (() => {
          const contentCandidates = Array.from(document.body?.children || [])
            .filter(
              (element) => !['STYLE', 'SCRIPT', 'LINK'].includes(element.tagName)
            )
          const contentElements = contentCandidates
            .map((element) => {
              const rect = element.getBoundingClientRect()
              const width = Math.max(
                rect.width,
                Number(element.scrollWidth) || 0
              )
              const height = Math.max(
                rect.height,
                Number(element.scrollHeight) || 0
              )

              return {
                left: rect.left,
                top: rect.top,
                right: rect.left + width,
                bottom: rect.top + height,
              }
            })
            .filter((rect) => rect.width > 0 && rect.height > 0)

          if (!contentElements.length) {
            return {
              left: 0,
              top: 0,
              width: Math.max(
                document.documentElement.scrollWidth,
                document.body.scrollWidth,
                1
              ),
              height: Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight,
                1
              ),
            }
          }

          const left = Math.max(
            0,
            Math.min(...contentElements.map((rect) => rect.left))
          )
          const top = Math.max(
            0,
            Math.min(...contentElements.map((rect) => rect.top))
          )
          const right = Math.max(
            ...contentElements.map((rect) => rect.right)
          )
          const bottom = Math.max(
            ...contentElements.map((rect) => rect.bottom)
          )

          return {
            left,
            top,
            width: Math.max(right - left, 1),
            height: Math.max(bottom - top, 1),
          }
        })()
      `)
      const displayLeft = Math.max(Math.floor(dimensions.left || 0), 0)
      const displayTop = Math.max(Math.floor(dimensions.top || 0), 0)
      const displayWidth = Math.min(
        Math.max(Math.ceil(dimensions.width), 1),
        4000
      )
      const displayHeight = Math.min(
        Math.max(Math.ceil(dimensions.height), 1),
        12000
      )
      const renderScale = 2
      const captureWidth = (displayLeft + displayWidth) * renderScale
      const captureHeight = (displayTop + displayHeight) * renderScale

      renderWindow.webContents.setZoomFactor(renderScale)
      renderWindow.setContentSize(captureWidth, captureHeight)
      await wait(100)

      const screenshot = await renderWindow.webContents.capturePage({
        x: 0,
        y: 0,
        width: captureWidth,
        height: captureHeight,
      })
      const outputScreenshot = trimToContent
        ? trimScreenshotToContent(screenshot, renderScale)
        : {
            image: screenshot,
            width: screenshot.getSize().width,
            height: screenshot.getSize().height,
          }
      const naturalDisplayWidth = Math.max(
        outputScreenshot.width / renderScale,
        1
      )
      const naturalDisplayHeight = Math.max(
        outputScreenshot.height / renderScale,
        1
      )
      const outputDisplayWidth = targetDisplayWidth
        ? targetDisplayWidth
        : naturalDisplayWidth
      const outputDisplayHeight = targetDisplayHeight
        ? targetDisplayHeight
        : naturalDisplayHeight * (outputDisplayWidth / naturalDisplayWidth)

      return {
        success: true,
        data:
          type === 'png'
            ? outputScreenshot.image.toPNG()
            : outputScreenshot.image.toJPEG(98),
        mimeType: type === 'png' ? 'image/png' : 'image/jpeg',
        width: outputScreenshot.width,
        height: outputScreenshot.height,
        displayWidth: Math.max(Math.ceil(outputDisplayWidth), 1),
        displayHeight: Math.max(Math.ceil(outputDisplayHeight), 1),
      }
    }

    return {
      success: false,
      error: `Unsupported HTML render type: ${type}`,
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Could not render the HTML attachment.',
    }
  } finally {
    if (!renderWindow.isDestroyed()) renderWindow.destroy()
  }
}

function stripHtmlToText(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function attachmentExtension(format) {
  return (
    {
      PDF: 'pdf',
      WKPDF: 'pdf',
      PDF_ENCODE: 'pdf',
      PDF_IMAGE: 'pdf',
      PDF_IMAGE_PNG: 'pdf',
      PNG: 'png',
      JPG: 'jpg',
      HEIC: 'heic',
      TXT: 'txt',
      DOCX: 'docx',
      XLSX: 'xlsx',
      PPTX: 'pptx',
      HTML: 'html',
    }[format] || 'html'
  )
}

function createAttachmentFileName(requestedName, format) {
  const extension = attachmentExtension(format)
  const baseName =
    String(requestedName || 'attachment')
      .trim()
      .replace(new RegExp(`\\.${extension}$`, 'i'), '')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'attachment'

  return `${path.basename(baseName)}.${extension}`
}

async function createXlsxImageBuffer(image) {
  const workbook = new ExcelJS.Workbook()
  const worksheet = workbook.addWorksheet('HTML')
  const width = Math.max(
    Number(image.displayWidth || image.width) || 1200,
    1
  )
  const height = Math.max(
    Number(image.displayHeight || image.height) || 900,
    1
  )
  const imageId = workbook.addImage({
    buffer: Buffer.from(image.data),
    extension: 'png',
  })

  worksheet.views = [{ showGridLines: false }]
  worksheet.addImage(imageId, {
    tl: { col: 0, row: 0, nativeCol: 0, nativeRow: 0 },
    ext: { width, height },
    editAs: 'oneCell',
  })

  return workbook.xlsx.writeBuffer()
}

async function convertPngBufferToHeic(pngData, directory) {
  if (process.platform !== 'darwin') {
    throw new Error('HEIC generation requires the macOS Electron app.')
  }

  const suffix = randomId().toLowerCase()
  const inputPath = path.join(directory, `attachment-${suffix}.png`)
  const outputPath = path.join(directory, `attachment-${suffix}.heic`)

  try {
    fs.writeFileSync(inputPath, Buffer.from(pngData))
    await runCommand('/usr/bin/sips', [
      '-s',
      'format',
      'heic',
      inputPath,
      '--out',
      outputPath,
    ])
    return fs.readFileSync(outputPath)
  } finally {
    for (const filePath of [inputPath, outputPath]) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    }
  }
}

async function createTemplatedAttachment(
  payload,
  row,
  directory,
  context = createTemplateContext(row)
) {
  const template = payload.attachmentTemplate
  const html = expandTemplate(template.html, row, context)
  const format = template.format
  const requestedFileName = String(template.fileName || '{{id}}').trim()
  const fileName = createAttachmentFileName(
    expandTemplate(requestedFileName, row, context),
    format
  )
  let data

  if (format === 'HTML') {
    data = Buffer.from(html, 'utf8')
  } else if (format === 'TXT') {
    data = Buffer.from(stripHtmlToText(html), 'utf8')
  } else if (
    ['PDF', 'WKPDF', 'PDF_ENCODE', 'PDF_IMAGE', 'PDF_IMAGE_PNG'].includes(
      format
    )
  ) {
    const rendered = await renderHtmlAsset({ html, type: 'pdf' })
    if (!rendered.success) throw new Error(rendered.error)
    data = Buffer.from(rendered.data)
  } else if (format === 'PNG' || format === 'JPG') {
    const rendered = await renderHtmlAsset({
      html,
      type: format === 'PNG' ? 'png' : 'jpeg',
    })
    if (!rendered.success) throw new Error(rendered.error)
    data = Buffer.from(rendered.data)
  } else if (format === 'HEIC') {
    const rendered = await renderHtmlAsset({ html, type: 'png' })
    if (!rendered.success) throw new Error(rendered.error)
    data = await convertPngBufferToHeic(rendered.data, directory)
  } else if (format === 'XLSX') {
    const rendered = await renderHtmlAsset({
      html,
      type: 'png',
      trimToContent: true,
    })
    if (!rendered.success) throw new Error(rendered.error)
    data = await createXlsxImageBuffer(rendered)
  } else if (format === 'DOCX') {
    const rendered = await renderHtmlAsset({ html, type: 'png' })
    if (!rendered.success) throw new Error(rendered.error)
    const width = Math.min(Number(rendered.width) || 1200, 650)
    const height =
      (Number(rendered.height) || 900) *
      (width / (Number(rendered.width) || 1200))
    const document = new Document({
      sections: [
        {
          children: [
            new Paragraph({
              children: [
                new ImageRun({
                  data: Buffer.from(rendered.data),
                  transformation: { width, height },
                }),
              ],
            }),
          ],
        },
      ],
    })
    data = await Packer.toBuffer(document)
  } else if (format === 'PPTX') {
    const rendered = await renderHtmlAsset({ html, type: 'png' })
    if (!rendered.success) throw new Error(rendered.error)
    const presentation = new PptxGenJS()
    const slide = presentation.addSlide()
    const width = Math.min(Number(rendered.width) || 1200, 1200)
    const height =
      (Number(rendered.height) || 900) *
      (width / (Number(rendered.width) || 1200))
    slide.background = { color: 'FFFFFF' }
    slide.addImage({
      data: `data:image/png;base64,${Buffer.from(rendered.data).toString(
        'base64'
      )}`,
      x: 0,
      y: 0,
      w: 13.333,
      h: Math.min(height / width * 13.333, 7.5),
    })
    data = await presentation.write({ outputType: 'nodebuffer' })
  } else {
    throw new Error(`Unsupported attachment format: ${format}`)
  }

  const attachmentPath = path.join(directory, fileName)
  fs.writeFileSync(attachmentPath, Buffer.from(data))
  return attachmentPath
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
    'div.dC > div[role="button"].aoO[data-tooltip^="Send"]',
    'div[role="button"].aoO[data-tooltip^="Send"]',
    'div[role="button"][data-tooltip^="Send"]',
    'div[role="button"][aria-label^="Send"]',
    'button[aria-label*="Send" i]',
    '[aria-label^="Send"]',
    '[data-tooltip^="Send"]',
    '[command="send"]',
    '.gU.Up',
  ]

  const selector = sendSelectors.join(', ')

  const candidates = await page.$$(selector)

  for (const button of candidates) {
    const ready = await button
      .evaluate((element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0 &&
          element.getAttribute('aria-disabled') !== 'true' &&
          !element.disabled
        )
      })
      .catch(() => false)

    if (!ready) continue

    try {
      // Use Puppeteer's real mouse interaction instead of HTMLElement.click().
      // Gmail's toolbar listens for the browser mouse event sequence.
      await button.click()
      return true
    } catch {
      // Try the next visible Send candidate if Gmail replaced this node.
    }
  }

  return false
}

async function pressMacSendShortcut(page) {
  await page.keyboard.down('Meta')
  try {
    await page.keyboard.press('Enter')
  } finally {
    await page.keyboard.up('Meta')
  }
}

async function sendOneEmail(
  page,
  payload,
  row,
  attachmentPath,
  templateContext = createTemplateContext(row)
) {
  const email = getRecipientValue(row, 'email')

  if (!email) {
    throw new Error('This CSV row does not contain an email address.')
  }

  const context = templateContext
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

  const useHtml = Boolean(payload.htmlMode || looksLikeHtml(body))

  if (useHtml) {
    await messageBody.evaluate((element, html) => {
      element.focus()
      element.innerHTML = html
      element.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          inputType: 'insertHTML',
          data: html,
        })
      )
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }, body)
  } else {
    await messageBody.type(body, { delay: typingDelay })
  }

  const clickedSendButton = await clickGmailSend(page)

  if (!clickedSendButton) {
    // Puppeteer requires modifier keys to be held separately; "Meta+Enter"
    // is not a valid key name.
    await pressMacSendShortcut(page)
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
    await pressMacSendShortcut(page)
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

    if (payload.attachment?.data || payload.attachmentTemplate) {
      // Keep the uploaded file's original basename so Gmail displays the
      // filename the user selected. Isolation comes from the unique temp
      // directory, not from changing the visible filename.
      attachmentDirectory = fs.mkdtempSync(
        path.join(app.getPath('temp'), 'mail-system-')
      )

      if (payload.attachment?.data) {
        const originalName =
          path.basename(payload.attachment.name || 'attachment') || 'attachment'
        attachmentPath = path.join(attachmentDirectory, originalName)
        fs.writeFileSync(
          attachmentPath,
          Buffer.from(new Uint8Array(payload.attachment.data))
        )
      }
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
      const templateContext = createTemplateContext(row)

      let recipientAttachmentPath = attachmentPath

      try {
        if (payload.attachmentTemplate) {
          recipientAttachmentPath = await createTemplatedAttachment(
            payload,
            row,
            attachmentDirectory,
            templateContext
          )
        }

        await sendOneEmail(
          connection.page,
          payload,
          row,
          recipientAttachmentPath,
          templateContext
        )
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
      } finally {
        if (
          payload.attachmentTemplate &&
          recipientAttachmentPath &&
          recipientAttachmentPath !== attachmentPath &&
          fs.existsSync(recipientAttachmentPath)
        ) {
          fs.unlinkSync(recipientAttachmentPath)
        }
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

ipcMain.handle('render-html-asset', async (_event, payload) =>
  renderHtmlAsset({
    html: payload?.html,
    type: payload?.type,
    targetDisplayWidth: payload?.targetDisplayWidth,
    targetDisplayHeight: payload?.targetDisplayHeight,
    trimToContent: payload?.trimToContent !== false,
  })
)

ipcMain.handle('create-xlsx-from-image', async (_event, payload) => {
  try {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('HTML')
    const width = Math.max(Number(payload?.width) || 1200, 1)
    const height = Math.max(Number(payload?.height) || 900, 1)
    const imageId = workbook.addImage({
      buffer: Buffer.from(new Uint8Array(payload?.data || [])),
      extension: 'png',
    })

    worksheet.views = [{ showGridLines: false }]
    worksheet.addImage(imageId, {
      tl: { col: 0, row: 0, nativeCol: 0, nativeRow: 0 },
      ext: { width, height },
      editAs: 'oneCell',
    })

    return {
      success: true,
      data: await workbook.xlsx.writeBuffer(),
      mimeType:
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Could not create the XLSX image attachment.',
    }
  }
})

ipcMain.handle('convert-png-to-heic', async (_event, payload) => {
  if (process.platform !== 'darwin') {
    return {
      success: false,
      error: 'HEIC generation requires the macOS Electron app.',
    }
  }

  let directory

  try {
    directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'mail-heic-'))
    const inputPath = path.join(directory, 'source.png')
    const outputPath = path.join(directory, 'output.heic')

    fs.writeFileSync(inputPath, Buffer.from(new Uint8Array(payload.data)))
    await runCommand('/usr/bin/sips', [
      '-s',
      'format',
      'heic',
      inputPath,
      '--out',
      outputPath,
    ])

    return {
      success: true,
      data: fs.readFileSync(outputPath),
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Could not create the HEIC attachment.',
    }
  } finally {
    if (directory && fs.existsSync(directory)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  }
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
