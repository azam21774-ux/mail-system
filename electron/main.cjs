const { app, BrowserWindow, ipcMain, safeStorage } = require('electron')
const { spawn, execFile } = require('child_process')
const crypto = require('crypto')
const http = require('http')
const path = require('path')
const fs = require('fs')
const puppeteer = require('puppeteer-core')
const sharp = require('sharp')
const ExcelJS = require('exceljs')
const { Document, ImageRun, Packer, Paragraph } = require('docx')
const PptxGenJS = require('pptxgenjs')
const { gmailOAuthClientId: packagedGmailOAuthClientId } = require('./oauth-config.cjs')
const { licenseServerUrl: packagedLicenseServerUrl } = require('./license-config.cjs')

const profilesRoot = path.join(app.getPath('userData'), 'chrome-profiles')
const gmailAccountsFile = path.join(app.getPath('userData'), 'gmail-accounts.json')
const licenseSessionFile = path.join(app.getPath('userData'), 'license-session.json')
const gmailOAuthScope =
  'openid email https://www.googleapis.com/auth/gmail.send'
const campaignJobs = new Map()
const activeUiProfilePorts = new Set()
const chromeProfileChecks = new Map()

let mainWindow

function getLicenseServerUrl() {
  return String(process.env.LICENSE_SERVER_URL || packagedLicenseServerUrl || '')
    .trim()
    .replace(/\/+$/, '')
}

function readLicenseSession() {
  try {
    return JSON.parse(fs.readFileSync(licenseSessionFile, 'utf8'))
  } catch {
    return null
  }
}

function writeLicenseSession(session) {
  fs.writeFileSync(licenseSessionFile, JSON.stringify(session, null, 2), 'utf8')
}

function clearLicenseSession() {
  try {
    fs.rmSync(licenseSessionFile, { force: true })
  } catch {
    // The session is already cleared.
  }
}

async function requestLicenseServer(endpoint, payload) {
  const baseUrl = getLicenseServerUrl()
  if (!baseUrl) {
    return {
      success: false,
      error:
        'License server is not configured. Reinstall a build connected to the administrator server.',
    }
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) {
    return {
      success: false,
      error: result.error || 'The license server rejected this request.',
    }
  }
  return result
}

async function validateStoredLicense() {
  const session = readLicenseSession()
  if (!session?.token) {
    return { success: false, activated: false }
  }

  try {
    const result = await requestLicenseServer('/api/license/validate', {
      token: session.token,
    })
    if (!result.success) {
      clearLicenseSession()
      return { success: false, activated: false, error: result.error }
    }
    return {
      success: true,
      activated: true,
      username: result.username || session.username,
      expiresAt: result.expiresAt || session.expiresAt,
    }
  } catch (error) {
    return {
      success: false,
      activated: false,
      offline: true,
      error: error.message || 'Could not reach the license server.',
    }
  }
}

function getChromePath() {
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.PROGRAMFILES || 'C:\\Program Files',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          ),
          path.join(
            process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          ),
          path.join(
            process.env.LOCALAPPDATA || '',
            'Google',
            'Chrome',
            'Application',
            'chrome.exe'
          ),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/google-chrome', '/usr/bin/chromium']

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null
}

// UI Sending drives Gmail through its live page. These flags prevent Chrome
// from throttling timers/rendering when a profile is in a background tab,
// behind another window, or minimized.
const backgroundAutomationChromeArgs = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
]

function openOAuthInChrome(authorizationUrl, profileKey = 'api-main') {
  return new Promise((resolve, reject) => {
    const chromePath = getChromePath()
    if (!chromePath) {
      reject(new Error('Google Chrome was not found. Install Chrome to connect Gmail.'))
      return
    }

    const safeProfileKey = String(profileKey)
      .replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 80)
    const profileDir = path.join(
      profilesRoot,
      `api-oauth-${safeProfileKey || 'main'}`
    )
    fs.mkdirSync(profileDir, { recursive: true })

    const chromeArgs = [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      authorizationUrl,
    ]
    const macLauncher = '/usr/bin/open'
    const useMacLauncher =
      process.platform === 'darwin' && fs.existsSync(macLauncher)
    const launchCommand = useMacLauncher ? macLauncher : chromePath
    const launchArgs = useMacLauncher
      ? ['-na', '/Applications/Google Chrome.app', '--args', ...chromeArgs]
      : chromeArgs
    const chrome = spawn(launchCommand, launchArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: process.platform === 'win32',
    })

    chrome.once('error', reject)
    chrome.once('spawn', () => {
      chrome.unref()
      resolve(true)
    })
  })
}

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

function getGmailOAuthClientId(clientIdOverride = '') {
  return String(
    clientIdOverride ||
      process.env.GOOGLE_OAUTH_CLIENT_ID ||
      packagedGmailOAuthClientId ||
      ''
  ).trim()
}

function publicGmailAccount(account) {
  return {
    id: account.id,
    email: account.email,
    connectedAt: account.connectedAt,
  }
}

function readGmailAccounts() {
  if (!fs.existsSync(gmailAccountsFile)) return []

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure token storage is not available on this device. Restart the app and try again.'
    )
  }

  const encrypted = fs.readFileSync(gmailAccountsFile, 'utf8').trim()
  if (!encrypted) return []

  const decrypted = safeStorage.decryptString(
    Buffer.from(encrypted, 'base64')
  )
  const accounts = JSON.parse(decrypted)
  return Array.isArray(accounts) ? accounts : []
}

function writeGmailAccounts(accounts) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'Secure token storage is not available on this device. Restart the app and try again.'
    )
  }

  fs.mkdirSync(path.dirname(gmailAccountsFile), { recursive: true })
  const encrypted = safeStorage.encryptString(JSON.stringify(accounts))
  fs.writeFileSync(gmailAccountsFile, encrypted.toString('base64'), {
    mode: 0o600,
  })
}

function createPkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url')
  const challenge = crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64url')

  return { verifier, challenge }
}

function waitForGoogleOAuthCallback(server, expectedState) {
  return withTimeout(
    new Promise((resolve, reject) => {
      server.on('request', (request, response) => {
        const requestUrl = new URL(
          request.url || '/',
          `http://${request.headers.host || '127.0.0.1'}`
        )

        if (requestUrl.pathname !== '/oauth/callback') {
          response.writeHead(404)
          response.end('Not found')
          return
        }

        const error = requestUrl.searchParams.get('error')
        const code = requestUrl.searchParams.get('code')
        const state = requestUrl.searchParams.get('state')

        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(
          `<html><body style="font-family:Arial;padding:32px"><h2>${
            error
              ? 'Gmail connection cancelled'
              : 'Authorization received'
          }</h2><p>${
            error
              ? 'You can close this browser tab and try again from Mail System.'
              : 'Return to Mail System while it finishes the Gmail connection.'
          }</p></body></html>`
        )

        if (error) {
          reject(new Error(`Google OAuth was not completed: ${error}`))
          return
        }

        if (!code || state !== expectedState) {
          reject(new Error('Google OAuth returned an invalid callback.'))
          return
        }

        resolve({ code })
      })
    }),
    5 * 60 * 1000,
    'Google OAuth timed out. Try connecting Gmail again.'
  )
}

async function connectGmailAccount(credentials = {}) {
  const clientIdOverride =
    typeof credentials === 'string' ? credentials : credentials.clientId
  const clientSecret =
    typeof credentials === 'string' ? '' : String(credentials.clientSecret || '').trim()
  const browserProfileId =
    typeof credentials === 'string'
      ? 'api-main'
      : credentials.browserProfileId || 'api-main'
  const clientId = getGmailOAuthClientId(clientIdOverride)
  if (!clientId) {
    throw new Error(
      'Google OAuth is not configured in this desktop build. Reinstall the latest Mail System installer.'
    )
  }

  const { verifier, challenge } = createPkcePair()
  const state = crypto.randomBytes(24).toString('hex')
  const server = http.createServer()

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`
    const authorizationUrl = new URL(
      'https://accounts.google.com/o/oauth2/v2/auth'
    )
    authorizationUrl.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: gmailOAuthScope,
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()

    const callbackPromise = waitForGoogleOAuthCallback(server, state)
    await openOAuthInChrome(authorizationUrl.toString(), browserProfileId)

    const { code } = await callbackPromise
    const tokenRequest = {
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }
    if (clientSecret) tokenRequest.client_secret = clientSecret

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(tokenRequest),
    })
    const tokenData = await tokenResponse.json()

    if (!tokenResponse.ok || !tokenData.access_token) {
      if (
        tokenData.error === 'invalid_client' ||
        /client[_ ]secret/i.test(
          tokenData.error_description || tokenData.error || ''
        )
      ) {
        throw new Error(
          'Google requires a Client Secret for this OAuth client. Enter its secret, or create a Desktop app OAuth Client ID that uses PKCE without a secret.'
        )
      }
      throw new Error(
        tokenData.error_description ||
          tokenData.error ||
          'Google did not return an access token.'
      )
    }

    const profileResponse = await fetch(
      'https://openidconnect.googleapis.com/v1/userinfo',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      }
    )
    const profileData = await profileResponse.json()
    if (!profileResponse.ok || !profileData.email) {
      throw new Error('Google did not return the Gmail account email.')
    }

    const accounts = readGmailAccounts()
    const existing = accounts.find(
      (account) =>
        account.email.toLowerCase() === String(profileData.email).toLowerCase()
    )
    const account = {
      id: existing?.id || crypto.randomUUID(),
      email: profileData.email,
      refreshToken: tokenData.refresh_token || existing?.refreshToken,
      accessToken: tokenData.access_token,
      accessTokenExpiresAt:
        Date.now() + Math.max(Number(tokenData.expires_in || 3600) - 60, 60) * 1000,
      connectedAt: existing?.connectedAt || new Date().toISOString(),
    }

    if (!account.refreshToken) {
      throw new Error(
        'Google did not return a refresh token. Try connecting this account again.'
      )
    }

    const nextAccounts = accounts.filter((item) => item.id !== account.id)
    nextAccounts.push(account)
    writeGmailAccounts(nextAccounts)

    return publicGmailAccount(account)
  } finally {
    server.close()
  }
}

async function getGmailAccessToken(accountId) {
  const clientId = getGmailOAuthClientId()
  const accounts = readGmailAccounts()
  const account = accounts.find((item) => item.id === String(accountId))

  if (!account) throw new Error('The selected Gmail account is not connected.')
  if (
    account.accessToken &&
    Number(account.accessTokenExpiresAt || 0) > Date.now()
  ) {
    return account.accessToken
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      refresh_token: account.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const tokenData = await tokenResponse.json()

  if (!tokenResponse.ok || !tokenData.access_token) {
    throw new Error(
      tokenData.error_description ||
        'The Gmail authorization expired. Connect this account again.'
    )
  }

  account.accessToken = tokenData.access_token
  account.accessTokenExpiresAt =
    Date.now() + Math.max(Number(tokenData.expires_in || 3600) - 60, 60) * 1000
  writeGmailAccounts(accounts)
  return account.accessToken
}

function wrapBase64(value) {
  return Buffer.from(value)
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\r\n') || ''
}

function encodeMimeHeader(value) {
  return `=?UTF-8?B?${Buffer.from(String(value || ''), 'utf8').toString(
    'base64'
  )}?=`
}

function mimeTypeForFile(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  return (
    {
      '.pdf': 'application/pdf',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.heic': 'image/heic',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.docx':
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xlsx':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx':
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    }[extension] || 'application/octet-stream'
  )
}

function createMimeMessage({
  recipient,
  subject,
  body,
  htmlMode,
  attachmentPath,
}) {
  const textBody = htmlMode ? stripHtmlToText(body) : String(body || '')
  const htmlBody = htmlMode
    ? String(body || '')
    : String(body || '').replace(/\r?\n/g, '<br>')
  const alternativeBoundary = `alt_${crypto.randomBytes(12).toString('hex')}`
  const hasAttachment = Boolean(attachmentPath)
  const mixedBoundary = `mixed_${crypto.randomBytes(12).toString('hex')}`
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    `--${alternativeBoundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(textBody),
    `--${alternativeBoundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(htmlBody),
    `--${alternativeBoundary}--`,
  ].join('\r\n')

  const headers = [
    'MIME-Version: 1.0',
    `To: ${recipient}`,
    `Subject: ${encodeMimeHeader(subject)}`,
  ]

  if (!hasAttachment) {
    headers.push(
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      alternative
    )
    return headers.join('\r\n')
  }

  const fileName = path.basename(attachmentPath)
  const attachment = fs.readFileSync(attachmentPath)
  headers.push(
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    alternative,
    `--${mixedBoundary}`,
    `Content-Type: ${mimeTypeForFile(attachmentPath)}; name="${fileName}"`,
    `Content-Disposition: attachment; filename="${fileName}"`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(attachment),
    `--${mixedBoundary}--`
  )

  return headers.join('\r\n')
}

async function sendGmailApiMessage(accountId, message, accessToken = null) {
  const resolvedAccessToken =
    accessToken || (await getGmailAccessToken(accountId))
  const response = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resolvedAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        raw: Buffer.from(message, 'utf8').toString('base64url'),
      }),
    }
  )
  const data = await response.json()

  if (!response.ok || !data.id) {
    throw new Error(
      data.error?.message || 'Gmail API could not send this message.'
    )
  }

  return data
}

function withTimeout(promise, milliseconds, message) {
  let timeoutId

  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), milliseconds)
  })

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timeoutId)
  })
}

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

function createTemplateContext(row, customVariables = {}) {
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
    tfn: String(customVariables.tfn ?? ''),
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

function sanitizeHtmlForRendering(source) {
  return String(source || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, '')
    .replace(
      /\b(src|href)\s*=\s*(['"])chrome-extension:[^'"]*\2/gi,
      '$1=$2$2'
    )
}

function createStandaloneHtml(source) {
  const html = sanitizeHtmlForRendering(source).trim()
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

function cropScreenshotToHtmlBounds(screenshot, dimensions, renderScale) {
  const size = screenshot.getSize()
  const cropX = Math.max(
    Math.floor(Number(dimensions.left || 0) * renderScale),
    0
  )
  const cropY = Math.max(
    Math.floor(Number(dimensions.top || 0) * renderScale),
    0
  )
  const cropRight = Math.min(
    Math.ceil(
      (Number(dimensions.left || 0) + Number(dimensions.width || 0)) *
        renderScale
    ),
    size.width
  )
  const cropBottom = Math.min(
    Math.ceil(
      (Number(dimensions.top || 0) + Number(dimensions.height || 0)) *
        renderScale
    ),
    size.height
  )
  const width = Math.max(cropRight - cropX, 1)
  const height = Math.max(cropBottom - cropY, 1)

  if (!size.width || !size.height) {
    return { image: screenshot, width: size.width, height: size.height }
  }

  return {
    image: screenshot.crop({
      x: cropX,
      y: cropY,
      width,
      height,
    }),
    width,
    height,
  }
}

async function captureHtmlScreenshot(
  webContents,
  { width, height, renderScale, type }
) {
  const debuggerSession = webContents.debugger
  let attachedHere = false

  try {
    if (!debuggerSession.isAttached()) {
      debuggerSession.attach('1.3')
      attachedHere = true
    }

    const result = await withTimeout(
      debuggerSession.sendCommand('Page.captureScreenshot', {
        format: type === 'jpeg' ? 'jpeg' : 'png',
        ...(type === 'jpeg' ? { quality: 98 } : {}),
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.max(Number(width) || 1, 1),
          height: Math.max(Number(height) || 1, 1),
          scale: renderScale,
        },
      }),
      12000,
      'Chromium screenshot capture timed out.'
    )

    return {
      data: Buffer.from(result.data, 'base64'),
      width: Math.max(Math.ceil(Number(width) || 1), 1) * renderScale,
      height: Math.max(Math.ceil(Number(height) || 1), 1) * renderScale,
    }
  } catch (error) {
    throw error
  } finally {
    if (attachedHere && debuggerSession.isAttached()) {
      debuggerSession.detach()
    }
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
    paintWhenInitiallyHidden: true,
    skipTaskbar: true,
    width: 1200,
    height: 900,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
    },
  })

  try {
    if (process.platform === 'win32') {
      // Windows can defer painting a fully hidden Chromium surface. Paint the
      // document in an inactive, non-taskbar window so screenshots and PDFs
      // contain the rendered page instead of a blank surface.
      renderWindow.showInactive()
      renderWindow.setOpacity(0)
      renderWindow.webContents.setBackgroundThrottling(false)
    }

    await withTimeout(
      renderWindow.loadURL(
        `data:text/html;charset=UTF-8,${encodeURIComponent(
          createStandaloneHtml(html)
        )}`
      ),
      15000,
      'The HTML attachment took too long to load.'
    )

    await withTimeout(
      renderWindow.webContents.executeJavaScript(`
        (async () => {
          if (document.fonts?.ready) {
            await Promise.race([
              document.fonts.ready,
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
          }

          await Promise.all(
            Array.from(document.images).map((image) => {
              if (image.complete) return Promise.resolve();
              return Promise.race([
                new Promise((resolve) => {
                  image.addEventListener('load', resolve, { once: true });
                  image.addEventListener('error', resolve, { once: true });
                }),
                new Promise((resolve) => setTimeout(resolve, 5000)),
              ]);
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
      `),
      15000,
      'The HTML attachment resources took too long to load.'
    )

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
      const dimensions = await withTimeout(
        renderWindow.webContents.executeJavaScript(`
          (() => {
          const contentRoots = Array.from(document.body?.children || []).filter(
            (element) => !['STYLE', 'SCRIPT', 'LINK'].includes(element.tagName)
          )
          const allElements = contentRoots.flatMap((root) => [
            root,
            ...root.querySelectorAll('*'),
          ])

          // HTML emails often place long lines or tables inside an overflow
          // clipped wrapper. An attachment should preserve that content rather
          // than silently cutting it at the wrapper's visual width.
          for (const element of [
            document.documentElement,
            document.body,
            ...allElements,
          ]) {
            element?.style.setProperty('overflow', 'visible', 'important')
          }

          const contentElements = allElements
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
                right: Math.max(rect.right, rect.left + width),
                bottom: Math.max(rect.bottom, rect.top + height),
              }
            })
            .filter((rect) => rect.right > rect.left && rect.bottom > rect.top)

          const textBounds = []
          for (const root of contentRoots) {
            const walker = document.createTreeWalker(
              root,
              NodeFilter.SHOW_TEXT
            )
            let node = walker.nextNode()
            while (node) {
              if (node.textContent?.trim()) {
                const range = document.createRange()
                range.selectNodeContents(node)
                for (const rect of range.getClientRects()) {
                  if (rect.width > 0 && rect.height > 0) {
                    textBounds.push({
                      left: rect.left,
                      top: rect.top,
                      right: rect.right,
                      bottom: rect.bottom,
                    })
                  }
                }
              }
              node = walker.nextNode()
            }
          }

          const bounds = [...contentElements, ...textBounds]
          if (!bounds.length) {
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
            Math.min(...bounds.map((rect) => rect.left))
          )
          const top = Math.max(
            0,
            Math.min(...bounds.map((rect) => rect.top))
          )
          const right = Math.max(...bounds.map((rect) => rect.right))
          const bottom = Math.max(...bounds.map((rect) => rect.bottom))

          return {
            left,
            top,
            width: Math.max(right - left, 1),
            height: Math.max(bottom - top, 1),
          }
          })()
        `),
        15000,
        'The HTML attachment layout could not be calculated.'
      )
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
      renderWindow.webContents.setZoomFactor(1)
      renderWindow.setContentSize(
        displayWidth,
        Math.max(Math.min(displayHeight, 900), 1)
      )
      await wait(100)

      const finalContentHeight = await withTimeout(
        renderWindow.webContents.executeJavaScript(`
          Math.max(
            document.documentElement?.scrollHeight || 0,
            document.body?.scrollHeight || 0,
            document.body?.firstElementChild?.scrollHeight || 0,
            1
          )
        `),
        15000,
        'The HTML attachment height could not be calculated.'
      )
      const finalDisplayHeight = Math.min(
        Math.max(Math.ceil(Number(finalContentHeight) || 0), displayHeight),
        12000
      )
      const outputScreenshot = await withTimeout(
        captureHtmlScreenshot(renderWindow.webContents, {
          width: displayWidth,
          height: trimToContent ? finalDisplayHeight : displayHeight,
          renderScale,
          type,
        }),
        30000,
        'The HTML attachment screenshot timed out.'
      )
      const naturalDisplayWidth = Math.max(outputScreenshot.width / renderScale, 1)
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
        data: outputScreenshot.data,
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
    editAs: 'absolute',
  })

  return workbook.xlsx.writeBuffer()
}

async function createPptxImageBuffer(image) {
  const imageWidth = Math.max(
    Number(image.displayWidth || image.width) || 1200,
    1
  )
  const imageHeight = Math.max(
    Number(image.displayHeight || image.height) || 900,
    1
  )
  const naturalWidth = imageWidth / 96
  const naturalHeight = imageHeight / 96
  const scale = Math.min(
    13.333 / naturalWidth,
    20 / naturalHeight
  )
  const slideWidth = naturalWidth * scale
  const slideHeight = naturalHeight * scale
  const presentation = new PptxGenJS()

  presentation.defineLayout({
    name: 'HTML_CONTENT',
    width: slideWidth,
    height: slideHeight,
  })
  presentation.layout = 'HTML_CONTENT'

  const slide = presentation.addSlide()
  slide.background = { color: 'FFFFFF' }
  slide.addImage({
    data: `data:image/png;base64,${Buffer.from(image.data).toString(
      'base64'
    )}`,
    x: 0,
    y: 0,
    w: slideWidth,
    h: slideHeight,
  })

  return presentation.write({ outputType: 'nodebuffer' })
}

async function convertPngBufferToHeic(pngData, directory) {
  const suffix = randomId().toLowerCase()
  const inputPath = path.join(directory, `attachment-${suffix}.png`)
  const outputPath = path.join(directory, `attachment-${suffix}.heic`)

  try {
    fs.writeFileSync(inputPath, Buffer.from(pngData))
    if (process.platform === 'darwin') {
      await runCommand('/usr/bin/sips', [
        '-s',
        'format',
        'heic',
        inputPath,
        '--out',
        outputPath,
      ])
    } else {
      try {
        const encoded = await sharp(Buffer.from(pngData))
          .heif({ compression: 'hevc', quality: 90 })
          .toBuffer()
        fs.writeFileSync(outputPath, encoded)
      } catch {
        const imageMagickCommand =
          process.platform === 'win32' ? 'magick' : 'convert'
        await runCommand(imageMagickCommand, [inputPath, outputPath])
      }
    }

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
    data = await createPptxImageBuffer(rendered)
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
  const gmailPages = pages.filter((candidate) =>
    candidate.url().includes('mail.google.com')
  )
  let page = gmailPages.at(-1)

  if (!page) {
    page = pages[0] || (await browser.newPage())
    await page.goto('https://mail.google.com/mail/u/0/#inbox', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
  }

  installGmailDialogHandler(page)
  await page.bringToFront()
  await page.waitForSelector(
    '[gh="cm"], [aria-label="Compose"], [role="button"][aria-label="Compose"]',
    { visible: true, timeout: 30000 }
  )
  await keepGmailPageActive(page)
  await dismissGmailNotificationSnackbar(page)

  return { browser, page }
}

async function keepGmailPageActive(page) {
  let session

  try {
    session = await page.createCDPSession()
    await session.send('Page.setWebLifecycleState', { state: 'active' })
    await session.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  } catch {
    // Older Chrome versions may not expose one of these CDP commands. The
    // background-safe launch flags still protect those profiles.
  } finally {
    await session?.detach().catch(() => {})
  }
}

async function checkChromeProfileInternal(port) {
  let browser

  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)

    if (!response.ok) {
      return {
        success: true,
        ready: false,
        reason: 'Chrome profile is not running.',
      }
    }

    const info = await response.json()
    browser = await puppeteer.connect({
      browserWSEndpoint: info.webSocketDebuggerUrl,
      defaultViewport: null,
    })

    const pages = await browser.pages()
    let page =
      pages.find((candidate) => candidate.url().includes('mail.google.com')) ||
      pages.find((candidate) => candidate.url().includes('google.com')) ||
      pages[0]

    if (!page) {
      page = await browser.newPage()
    }

    const currentUrl = page.url()

    if (currentUrl.includes('accounts.google.com')) {
      return {
        success: true,
        ready: false,
        reason: 'Waiting for Gmail account.',
      }
    }

    if (!currentUrl.includes('mail.google.com')) {
      await page.goto('https://mail.google.com/mail/u/0/#inbox', {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      })
    }

    await page.waitForSelector(
      '[gh="cm"], [aria-label="Compose"], [role="button"][aria-label="Compose"]',
      { visible: true, timeout: 2500 }
    )

    return {
      success: true,
      ready: true,
      url: page.url(),
    }
  } catch (error) {
    return {
      success: true,
      ready: false,
      reason: error.message || 'Waiting for Gmail account.',
    }
  } finally {
    browser?.disconnect()
  }
}

async function checkChromeProfile(port) {
  const debugPort = Number(port) || 9222

  // A health probe must never attach to a Gmail page that is actively
  // composing and sending. Even a read-only CDP connection can race with
  // Gmail's DOM updates and make a four-to-five profile batch appear stuck.
  if (activeUiProfilePorts.has(debugPort)) {
    return {
      success: true,
      ready: true,
      busy: true,
      reason: 'Chrome profile is currently sending.',
    }
  }

  const existingCheck = chromeProfileChecks.get(debugPort)
  if (existingCheck) return existingCheck

  const checkPromise = checkChromeProfileInternal(debugPort)
  chromeProfileChecks.set(debugPort, checkPromise)

  try {
    return await checkPromise
  } finally {
    if (chromeProfileChecks.get(debugPort) === checkPromise) {
      chromeProfileChecks.delete(debugPort)
    }
  }
}

const composeAttachmentSelector =
  '[aria-label*="Remove attachment" i], [data-tooltip*="Remove attachment" i], [title*="Remove attachment" i], .aYF'
const composeUploadProgressSelector =
  '[role="progressbar"], [aria-label*="Uploading" i], [aria-label*="uploading" i]'
const composeAnchorAttribute = 'data-mail-system-compose-anchor'
const composeRecipientSelector = [
  'input[aria-label="To recipients"]',
  'input[role="combobox"][aria-label="To recipients"]',
  '[aria-label*="recipient" i]',
  'input[name="to"]',
  '[placeholder*="recipient" i]',
  '[role="combobox"]',
].join(', ')

function ownedComposeSelector(token) {
  return `[data-mail-system-compose="${token}"]`
}

async function openOwnedCompose(page, token) {
  await page.evaluate((snapshotToken) => {
    const roots = new Set(
      Array.from(document.querySelectorAll('input[name="subjectbox"]'))
        .map(
          (subject) =>
            subject.closest('[role="dialog"]') ||
            subject.closest('.M9') ||
            subject.closest('.AD')
        )
        .filter(Boolean)
    )

    for (const root of roots) {
      root.setAttribute('data-mail-system-compose-snapshot', snapshotToken)
    }
  }, token)

  try {
    const composeButton = await page.waitForSelector(
      '[gh="cm"], [aria-label="Compose"], [role="button"][aria-label="Compose"]',
      { visible: true, timeout: 15000 }
    )
    await composeButton.click()

    await page.waitForFunction(
      (composeToken) => {
        const visible = (element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getAttribute('aria-hidden') !== 'true' &&
            rect.width > 0 &&
            rect.height > 0
          )
        }
        const roots = new Set(
          Array.from(document.querySelectorAll('input[name="subjectbox"]'))
            .map(
              (subject) =>
                subject.closest('[role="dialog"]') ||
                subject.closest('.M9') ||
                subject.closest('.AD')
            )
            .filter(Boolean)
        )
        const newRoot = Array.from(roots).find(
          (root) =>
            visible(root) &&
            root.getAttribute('data-mail-system-compose-snapshot') !==
              composeToken
        )

        if (!newRoot) return false
        newRoot.setAttribute('data-mail-system-compose', composeToken)
        const subject = newRoot.querySelector('input[name="subjectbox"]')
        subject?.setAttribute(composeAnchorAttribute, composeToken)
        return true
      },
      { timeout: 15000 },
      token
    )

    const compose = await page.$(ownedComposeSelector(token))
    if (!compose) {
      throw new Error('Gmail opened Compose, but it could not be isolated.')
    }

    return { token, compose }
  } catch (error) {
    // The root can appear just as the wait times out. Claim it before cleanup
    // so sendOneEmail can still discard the draft instead of leaking it.
    const claimed = await page
      .evaluate((composeToken) => {
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
        const roots = new Set(
          Array.from(document.querySelectorAll('input[name="subjectbox"]'))
            .map(
              (subject) =>
                subject.closest('[role="dialog"]') ||
                subject.closest('.M9') ||
                subject.closest('.AD')
            )
            .filter(Boolean)
        )
        const unclaimedRoot = Array.from(roots).find(
          (root) =>
            visible(root) &&
            root.getAttribute('data-mail-system-compose-snapshot') !==
              composeToken
        )
        if (unclaimedRoot) {
          unclaimedRoot.setAttribute('data-mail-system-compose', composeToken)
          const subject = unclaimedRoot.querySelector(
            'input[name="subjectbox"]'
          )
          subject?.setAttribute(composeAnchorAttribute, composeToken)
          return true
        }
        return false
      }, token)
      .catch(() => false)
    if (!claimed) {
      throw stopCampaignError(
        `${error.message} Gmail Compose ownership was uncertain, so this profile was stopped.`
      )
    }
    throw error
  } finally {
    await page
      .evaluate((snapshotToken) => {
        for (const element of document.querySelectorAll(
          '[data-mail-system-compose-snapshot]'
        )) {
          if (
            element.getAttribute('data-mail-system-compose-snapshot') ===
            snapshotToken
          ) {
            element.removeAttribute('data-mail-system-compose-snapshot')
          }
        }
        for (const element of document.querySelectorAll(
          `[${composeAnchorAttribute}]`
        )) {
          if (element.getAttribute(composeAnchorAttribute) === snapshotToken) {
            element.removeAttribute(composeAnchorAttribute)
          }
        }
      }, token)
      .catch(() => {})
  }
}

async function rebindOwnedCompose(page, token) {
  return page
    .evaluate((composeToken, anchorAttribute) => {
      const ownedSelector = `[data-mail-system-compose="${composeToken}"]`
      if (document.querySelector(ownedSelector)) return true

      const anchor = document.querySelector(
        `[${anchorAttribute}="${composeToken}"]`
      )
      if (!anchor) return false

      const root =
        anchor.closest('[role="dialog"]') ||
        anchor.closest('.M9') ||
        anchor.closest('.AD')
      if (!root) return false

      root.setAttribute('data-mail-system-compose', composeToken)
      return true
    }, token, composeAnchorAttribute)
    .catch(() => false)
}

async function waitForVisibleComposeSelector(
  compose,
  selector,
  timeout = 15000
) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const candidates = await compose.$$(selector).catch(() => [])

    for (const candidate of candidates) {
      const visible = await candidate
        .evaluate((element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          return (
            element.isConnected &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            element.getAttribute('aria-hidden') !== 'true' &&
            rect.width > 0 &&
            rect.height > 0
          )
        })
        .catch(() => false)

      if (visible) return candidate
      await candidate.dispose().catch(() => {})
    }

    await wait(150)
  }

  throw new Error('Gmail Compose did not show the required control.')
}

async function getOwnedComposeHandle(page, token) {
  await rebindOwnedCompose(page, token)
  const compose = await page.$(ownedComposeSelector(token))
  if (!compose) {
    throw stopCampaignError(
      'Gmail replaced the owned Compose before the next field could be filled. Profile stopped to prevent cross-compose input.'
    )
  }
  return compose
}

async function getOwnedAttachmentState(page, token) {
  await rebindOwnedCompose(page, token)
  return page.evaluate(
    (composeToken, attachmentSelector, progressSelector) => {
      const root = document.querySelector(
        `[data-mail-system-compose="${composeToken}"]`
      )
      if (!root || !root.isConnected) {
        return { exists: false, attachments: 0, uploading: false }
      }

      const visible = (element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getAttribute('aria-hidden') !== 'true' &&
          rect.width > 0 &&
          rect.height > 0
        )
      }
      const attachmentRoots = new Set(
        Array.from(root.querySelectorAll(attachmentSelector))
          .filter(visible)
          .map(
            (control) =>
              control.closest('.aZo, [data-attachment-id]') || control
          )
      )

      return {
        exists: true,
        attachments: attachmentRoots.size,
        uploading: Array.from(root.querySelectorAll(progressSelector)).some(
          visible
        ),
      }
    },
    token,
    composeAttachmentSelector,
    composeUploadProgressSelector
  )
}

async function waitForAttachmentUpload(page, token) {
  await page.waitForFunction(
    (composeToken, attachmentSelector, progressSelector, anchorAttribute) => {
      let root = document.querySelector(
        `[data-mail-system-compose="${composeToken}"]`
      )
      if (!root) {
        const anchor = document.querySelector(
          `[${anchorAttribute}="${composeToken}"]`
        )
        root =
          anchor?.closest('[role="dialog"]') ||
          anchor?.closest('.M9') ||
          anchor?.closest('.AD') ||
          null
        root?.setAttribute('data-mail-system-compose', composeToken)
      }
      if (!root || !root.isConnected) return false

      const visible = (element) => {
        const style = window.getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          element.getAttribute('aria-hidden') !== 'true' &&
          rect.width > 0 &&
          rect.height > 0
        )
      }
      const attachments = Array.from(
        root.querySelectorAll(attachmentSelector)
      ).filter(visible)
      const attachmentRoots = new Set(
        attachments.map(
          (control) =>
            control.closest('.aZo, [data-attachment-id]') || control
        )
      )
      const uploadStillRunning = Array.from(
        root.querySelectorAll(progressSelector)
      ).some(visible)

      return attachmentRoots.size === 1 && !uploadStillRunning
    },
    { timeout: 45000 },
    token,
    composeAttachmentSelector,
    composeUploadProgressSelector,
    composeAnchorAttribute
  )

  // Gmail can briefly show one completed chip before a delayed duplicate is
  // inserted. Require the owned compose to remain stable before continuing.
  await wait(750)
  const state = await getOwnedAttachmentState(page, token)
  if (!state.exists || state.uploading || state.attachments !== 1) {
    throw new Error(
      `Gmail attachment upload was not stable (found ${state.attachments}).`
    )
  }
}

async function dismissGmailNotificationSnackbar(page, timeout = 150) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const dismissed = await page
      .evaluate(() => {
        const normalize = (value) =>
          String(value || '')
            .replace(/\s+/g, ' ')
            .trim()
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
        const notificationText =
          /enable desktop notifications\s+for\s+gmail/i

        const getNotificationScope = (element) => {
          let current = element
          for (let depth = 0; current && depth < 8; depth += 1) {
            const text = normalize(current.innerText || current.textContent)
            if (notificationText.test(text)) return current
            current = current.parentElement
          }
          return null
        }

        const controls = Array.from(
          document.querySelectorAll(
            'button, [role="button"], [aria-label], [data-tooltip], [title]'
          )
        )

        const dismissControl = controls.find((element) => {
          if (!visible(element)) return false

          const scope = getNotificationScope(element)
          if (!scope) return false

          const text = normalize(element.innerText || element.textContent)
          const label = normalize(
            element.getAttribute('aria-label') ||
              element.getAttribute('data-tooltip') ||
              element.getAttribute('title')
          )

          return (
            /^no,?\s*thanks$/i.test(text) ||
            /^no,?\s*thanks$/i.test(label) ||
            /^close$/i.test(label) ||
            /\bclose\b/i.test(label)
          )
        })

        if (!dismissControl) return false
        dismissControl.click()
        return true
      })
      .catch(() => false)

    if (dismissed) return true
    await wait(Math.min(50, Math.max(deadline - Date.now(), 0)))
  }

  return false
}

async function clickGmailSend(compose, timeout = 10000) {
  const sendSelectors = [
    'div.T-I.J-J5-Ji.aoO.v7.T-I-atl.L3[role="button"][data-tooltip^="Send"]',
    'div.dC > div[role="button"].aoO[data-tooltip^="Send"]',
    'div[role="button"].aoO[data-tooltip^="Send"]',
    'div[role="button"][data-tooltip^="Send"]',
    'div[role="button"][command="send"]',
    'button[aria-label*="Send" i]',
    '[data-tooltip^="Send"]',
    '[command="send"]',
    '.gU.Up',
  ]

  const selector = sendSelectors.join(', ')
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const candidates = await compose.$$(selector).catch(() => [])

    for (const button of candidates) {
      const ready = await button
        .evaluate((element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const normalize = (value) =>
            String(value || '')
              .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
              .replace(/\s+/g, ' ')
              .trim()
          const labels = [
            element.getAttribute('aria-label'),
            element.getAttribute('data-tooltip'),
            element.getAttribute('title'),
          ]
            .map(normalize)
            .filter(Boolean)
          const isComposeSend =
            element.getAttribute('command') === 'send' ||
            element.classList.contains('aoO') ||
            labels.some(
              (label) =>
                /^send(?:\s*(?:\(|\[|$))/i.test(label) &&
                !/\bfeedback\b/i.test(label)
            )

          return (
            isComposeSend &&
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
        await button.scrollIntoViewIfNeeded().catch(() => {})
        const box = await button.boundingBox()
        if (!box) continue

        // Click the verified compose Send control. The previous broad
        // aria-label selector could match Gmail's unrelated Send feedback
        // control before it reached the compose toolbar.
        await button.click()
        return true
      } catch {
        // Gmail can replace the toolbar node while the compose window settles.
      }
    }

    await wait(200)
  }

  return false
}

async function confirmEmptyComposeIfVisible(page, timeout = 2500) {
  const deadline = Date.now() + timeout

  while (Date.now() < deadline) {
    const dialogs = await page.$$(
      '[role="dialog"], [role="alertdialog"], .Kj-JD'
    )

    for (const dialog of dialogs) {
      const promptIsVisible = await dialog
        .evaluate((element) => {
          const style = window.getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          const text = (element.innerText || element.textContent || '').trim()

          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0 &&
            /without\s+(a\s+)?subject|without\s+(a\s+)?body|no\s+subject|no\s+body|empty\s+(subject|body)/i.test(
              text
            )
          )
        })
        .catch(() => false)

      if (!promptIsVisible) continue

      const buttons = await dialog.$$('button, [role="button"], .Kj-JD-Kq')
      for (const button of buttons) {
        const shouldConfirm = await button
          .evaluate((element) => {
            const style = window.getComputedStyle(element)
            const rect = element.getBoundingClientRect()
            const text = (element.innerText || element.textContent || '')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase()

            return (
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              rect.width > 0 &&
              rect.height > 0 &&
              !/cancel|back|edit/.test(text) &&
              /^(send|send anyway|send without|yes|continue|ok)$/.test(text)
            )
          })
          .catch(() => false)

        if (!shouldConfirm) continue

        try {
          await button.focus().catch(() => {})
          // Gmail's confirmation is confirmed with Enter in the same way a
          // user confirms the native prompt. Keep a click fallback for
          // Gmail variants that do not move focus to the confirmation button.
          await page.keyboard.press('Enter')
          await wait(100)
          const stillVisible = await dialog
            .evaluate((element) => {
              const style = window.getComputedStyle(element)
              const rect = element.getBoundingClientRect()
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0
              )
            })
            .catch(() => false)

          if (stillVisible) await button.click()
          return true
        } catch {
          // Gmail may replace the dialog node after the first click.
        }
      }
    }

    await wait(150)
  }

  return false
}

const gmailDialogHandlers = new WeakMap()

function installGmailDialogHandler(page) {
  if (gmailDialogHandlers.has(page)) return

  const handler = async (dialog) => {
    const message = dialog.message()
    const isEmptyComposePrompt =
      /send this message without[\s\S]*(subject|body|text)/i.test(message)

    try {
      if (isEmptyComposePrompt) {
        await dialog.accept()
      } else {
        await dialog.dismiss()
      }
    } catch {
      // Gmail may close or replace the dialog immediately after sending.
    }
  }

  page.on('dialog', handler)
  gmailDialogHandlers.set(page, handler)
}

async function waitForComposeClosed(page, token, timeout = 15000) {
  return page
    .waitForFunction(
      (composeToken) => {
        const root = document.querySelector(
          `[data-mail-system-compose="${composeToken}"]`
        )
        if (!root || !root.isConnected) return true

        const style = window.getComputedStyle(root)
        const rect = root.getBoundingClientRect()
        return (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          root.getAttribute('aria-hidden') === 'true' ||
          rect.width === 0 ||
          rect.height === 0
        )
      },
      { timeout },
      token
    )
    .then(() => true)
    .catch(() => false)
}

async function isOwnedComposeOpen(page, token) {
  return page
    .evaluate((composeToken) => {
      const root = document.querySelector(
        `[data-mail-system-compose="${composeToken}"]`
      )
      if (!root || !root.isConnected) return false

      const style = window.getComputedStyle(root)
      const rect = root.getBoundingClientRect()
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        root.getAttribute('aria-hidden') !== 'true' &&
        rect.width > 0 &&
        rect.height > 0
      )
    }, token)
    .catch(() => false)
}

async function discardOwnedCompose(page, token, timeout = 8000) {
  if (!(await isOwnedComposeOpen(page, token))) return true

  const compose = await page.$(ownedComposeSelector(token))
  if (!compose) return true

  try {
    const discardButton = await waitForVisibleComposeSelector(
      compose,
      '[command="discard"], [aria-label*="Discard draft" i], [data-tooltip*="Discard draft" i], [title*="Discard draft" i]',
      3000
    )
    await discardButton.click()
    return waitForComposeClosed(page, token, timeout)
  } catch {
    return false
  }
}

async function armSendOutcomeObserver(page, token) {
  await page.evaluate((noticeToken) => {
    window.__mailSystemSendOutcomes ||= {}
    window.__mailSystemSendOutcomes[noticeToken]?.observer?.disconnect()

    const selector = '[role="status"], [role="alert"], .vh'
    const state = { result: null, observer: null }
    const noticeBaselines = new Map()
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
    const noticeSignature = (element) => {
      const text = String(element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
      return `${visible(element) ? 'visible' : 'hidden'}:${text}`
    }
    const classifyChangedNotice = (element) => {
      if (!element) return null
      const signature = noticeSignature(element)
      const previousSignature = noticeBaselines.get(element)
      noticeBaselines.set(element, signature)
      if (previousSignature === signature || !visible(element)) return null

      const text = String(element.innerText || element.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
      if (
        /couldn['’]?t send|could not send|not sent|failed to send|error sending/i.test(
          text
        )
      ) {
        return 'error'
      }
      return /\bmessage sent\b/i.test(text) ? 'sent' : null
    }
    for (const existingNotice of document.querySelectorAll(selector)) {
      noticeBaselines.set(existingNotice, noticeSignature(existingNotice))
    }

    const closestNotice = (node) => {
      const element =
        node?.nodeType === Node.ELEMENT_NODE
          ? node
          : node?.parentElement || null
      if (!element) return null
      return element.matches?.(selector)
        ? element
        : element.closest?.(selector) || null
    }

    const addedNotices = (node) => {
      const element =
        node?.nodeType === Node.ELEMENT_NODE
          ? node
          : node?.parentElement || null
      if (!element) return []

      return [
        ...(element.matches?.(selector) ? [element] : []),
        ...(element.querySelectorAll?.(selector) || []),
      ]
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const candidates = new Set()
        const containingNotice = closestNotice(mutation.target)
        if (containingNotice) candidates.add(containingNotice)

        if (mutation.type === 'childList') {
          for (const addedNode of mutation.addedNodes) {
            for (const notice of addedNotices(addedNode)) {
              candidates.add(notice)
            }
          }
        }

        for (const candidate of candidates) {
          const result = classifyChangedNotice(candidate)
          if (!result) continue
          state.result = result
          observer.disconnect()
          return
        }
      }
    })
    state.observer = observer
    window.__mailSystemSendOutcomes[noticeToken] = state
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-hidden'],
    })
  }, token)
}

async function clearSendOutcomeObserver(page, token) {
  await page
    .evaluate((noticeToken) => {
      const outcomes = window.__mailSystemSendOutcomes
      outcomes?.[noticeToken]?.observer?.disconnect()
      if (outcomes) delete outcomes[noticeToken]
    }, token)
    .catch(() => {})
}

async function waitForSendOutcome(page, token, timeout = 10000) {
  try {
    const handle = await page.waitForFunction(
      (noticeToken) => {
        return window.__mailSystemSendOutcomes?.[noticeToken]?.result || false
      },
      { timeout },
      token
    )
    return handle.jsonValue()
  } catch {
    return 'unknown'
  } finally {
    await clearSendOutcomeObserver(page, token)
  }
}

function stopCampaignError(message) {
  const error = new Error(message)
  error.stopCampaign = true
  return error
}

async function sendOneEmail(
  page,
  payload,
  row,
  attachmentPath,
  templateContext = createTemplateContext(row)
) {
  await keepGmailPageActive(page)
  const email = getRecipientValue(row, 'email')

  if (!email) {
    throw new Error('This CSV row does not contain an email address.')
  }

  const context = templateContext
  const expandedSubject = expandTemplate(payload.subject, row, context)
  const body = expandTemplate(payload.body, row, context)
  const bodyText = body
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .trim()
  const needsEmptyComposeConfirmation =
    !expandedSubject.trim() || !bodyText
  const typingDelay = Math.max(Number(payload.typingDelayMs) || 0, 0)
  let compose
  const composeToken = crypto.randomBytes(12).toString('hex')
  let sendInitiated = false
  let confirmedSent = false

  try {
    const ownedCompose = await openOwnedCompose(page, composeToken)
    compose = ownedCompose.compose

    if (attachmentPath) {
      // Always open the chooser from this exact compose. Page-global hidden
      // file inputs can belong to an older draft and cause duplicate uploads.
      const attachmentButton = await waitForVisibleComposeSelector(
        compose,
        '[command="Files"], [aria-label*="Attach"], .a1.aaA.aMZ'
      )
      const [fileChooser] = await Promise.all([
        page.waitForFileChooser({ timeout: 15000 }),
        attachmentButton.click(),
      ])
      await fileChooser.accept([attachmentPath])

      // Require exactly one stable attachment in the owned compose before
      // entering any recipient data.
      await waitForAttachmentUpload(page, composeToken)
    }

    // Gmail can replace the compose subtree while its recipient editor
    // initializes. Re-query the owned root instead of using a stale handle
    // captured immediately after the Compose click.
    compose = await getOwnedComposeHandle(page, composeToken)
    const recipientInput = await waitForVisibleComposeSelector(
      compose,
      composeRecipientSelector
    )
    await recipientInput.click()

    // Gmail's PeopleKit editor can replace the input immediately after it is
    // clicked. Re-query the owned compose and type through the actual field
    // handle so the exact input receives the text even if focus moved during
    // the click. ElementHandle.type supports both input and contenteditable
    // combobox variants.
    compose = await getOwnedComposeHandle(page, composeToken)
    const activeRecipientInput = await waitForVisibleComposeSelector(
      compose,
      composeRecipientSelector
    )
    await activeRecipientInput.focus()
    await activeRecipientInput.type(email, { delay: typingDelay })
    await page.keyboard.press('Enter')

    compose = await getOwnedComposeHandle(page, composeToken)
    const subjectInput = await waitForVisibleComposeSelector(
      compose,
      'input[name="subjectbox"]'
    )
    await subjectInput.click()
    await subjectInput.type(expandedSubject, { delay: typingDelay })

    compose = await getOwnedComposeHandle(page, composeToken)
    const messageBody = await waitForVisibleComposeSelector(
      compose,
      '[aria-label="Message Body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]'
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

    const attachmentState = await getOwnedAttachmentState(page, composeToken)
    if (
      !attachmentState.exists ||
      attachmentState.uploading ||
      attachmentState.attachments !== (attachmentPath ? 1 : 0)
    ) {
      throw new Error(
        `Gmail Compose attachment check failed before Send (found ${attachmentState.attachments}).`
      )
    }

    // Dismiss the unrelated notification prompt, arm a mutation observer for
    // the next Gmail send result, and click Send exactly once in this compose.
    await keepGmailPageActive(page)
    await dismissGmailNotificationSnackbar(page)
    await armSendOutcomeObserver(page, composeToken)
    compose = await getOwnedComposeHandle(page, composeToken)
    const clickedSendButton = await clickGmailSend(compose)

    if (!clickedSendButton) {
      throw new Error('Gmail did not expose Send in the current compose.')
    }
    sendInitiated = true

    if (needsEmptyComposeConfirmation) {
      await confirmEmptyComposeIfVisible(page, 1500)
    }

    const [composeClosed, sendOutcome] = await Promise.all([
      waitForComposeClosed(page, composeToken),
      waitForSendOutcome(page, composeToken),
    ])

    if (sendOutcome === 'sent' && composeClosed) {
      confirmedSent = true
      await wait(800)
      return
    }

    if (sendOutcome === 'sent' && !composeClosed) {
      throw stopCampaignError(
        'Gmail showed a Send notice, but the compose stayed open. Campaign stopped because the result was inconsistent.'
      )
    }

    if (sendOutcome === 'error') {
      throw new Error('Gmail reported that the message could not be sent.')
    }

    if (composeClosed) {
      throw stopCampaignError(
        'Gmail closed Compose, but delivery could not be confirmed. Campaign stopped to prevent a duplicate.'
      )
    }

    throw new Error(
      'Gmail did not complete Send. The compose will be discarded before continuing.'
    )
  } catch (error) {
    await clearSendOutcomeObserver(page, composeToken)
    const composeStillOpen =
      composeToken && (await isOwnedComposeOpen(page, composeToken))

    if (composeStillOpen) {
      const cleaned = await discardOwnedCompose(page, composeToken)
      if (!cleaned) {
        throw stopCampaignError(
          `${error.message} Gmail Compose could not be cleaned up, so this profile was stopped.`
        )
      }
    } else if (sendInitiated && !confirmedSent && !error.stopCampaign) {
      throw stopCampaignError(
        `${error.message} Delivery is uncertain, so this profile was stopped to prevent a duplicate.`
      )
    }

    throw error
  }
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

ipcMain.handle('connect-gmail', async (_event, credentials) => {
  try {
    return { success: true, account: await connectGmailAccount(credentials) }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Could not connect the Gmail account.',
    }
  }
})

ipcMain.handle('list-gmail-accounts', async () => {
  try {
    return {
      success: true,
      accounts: readGmailAccounts().map(publicGmailAccount),
    }
  } catch (error) {
    return {
      success: false,
      accounts: [],
      error: error.message || 'Could not load Gmail accounts.',
    }
  }
})

ipcMain.handle('disconnect-gmail', async (_event, accountId) => {
  try {
    const accounts = readGmailAccounts()
    const nextAccounts = accounts.filter(
      (account) => account.id !== String(accountId)
    )
    writeGmailAccounts(nextAccounts)
    return { success: true, accounts: nextAccounts.map(publicGmailAccount) }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Could not disconnect the Gmail account.',
    }
  }
})

ipcMain.handle('validate-license', async () => {
  return validateStoredLicense()
})

ipcMain.handle('activate-license', async (_event, payload = {}) => {
  try {
    const deviceIdFile = path.join(app.getPath('userData'), 'device-id')
    let deviceId
    try {
      deviceId = fs.readFileSync(deviceIdFile, 'utf8').trim()
    } catch {
      deviceId = crypto.randomUUID()
      fs.writeFileSync(deviceIdFile, deviceId, 'utf8')
    }

    const result = await requestLicenseServer('/api/license/activate', {
      username: String(payload.username || '').trim(),
      licenseKey: String(payload.licenseKey || '').trim(),
      deviceId,
    })
    if (!result.success || !result.token) return result

    writeLicenseSession({
      token: result.token,
      username: result.username,
      expiresAt: result.expiresAt,
    })
    return {
      success: true,
      activated: true,
      username: result.username,
      expiresAt: result.expiresAt,
    }
  } catch (error) {
    return {
      success: false,
      error: error.message || 'Could not activate this license.',
    }
  }
})

ipcMain.handle('deactivate-license', async () => {
  clearLicenseSession()
  return { success: true }
})

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
      error: 'Open this Chrome profile first, then click Send.',
    }
  }
})

ipcMain.handle('check-chrome-profile', async (_event, port) => {
  return checkChromeProfile(Number(port) || 9222)
})

ipcMain.handle('run-campaign', async (_event, payload) => {
  const campaignId = String(payload?.campaignId || '')
  const debugPort = Number(payload?.port) || 9222
  const job = {
    cancelled: false,
  }

  if (!campaignId) {
    return { success: false, error: 'Campaign ID is required.' }
  }

  if (campaignJobs.has(campaignId)) {
    return { success: false, error: 'This campaign is already running.' }
  }

  if (activeUiProfilePorts.has(debugPort)) {
    return {
      success: false,
      error: 'This Chrome profile is already sending another campaign.',
    }
  }

  campaignJobs.set(campaignId, job)
  activeUiProfilePorts.add(debugPort)

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
      const templateContext = createTemplateContext(
        row,
        payload.customVariables || {}
      )

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
        const mustStopProfile = Boolean(error.stopCampaign)
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
        if (mustStopProfile) throw error
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
    activeUiProfilePorts.delete(debugPort)
    if (browser) browser.disconnect()
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      fs.unlinkSync(attachmentPath)
    }
    if (attachmentDirectory && fs.existsSync(attachmentDirectory)) {
      fs.rmdirSync(attachmentDirectory)
    }
  }
})

ipcMain.handle('run-api-campaign', async (_event, payload) => {
  const campaignId = String(payload?.campaignId || '')
  const job = { cancelled: false }

  if (!campaignId) {
    return { success: false, error: 'Campaign ID is required.' }
  }

  if (campaignJobs.has(campaignId)) {
    return { success: false, error: 'This campaign is already running.' }
  }

  campaignJobs.set(campaignId, job)

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
      gmailAccountId: payload.gmailAccountId,
      ...progress,
    })
  }

  try {
    if (!recipients.length) {
      throw new Error('The campaign CSV does not contain any recipients.')
    }

    if (payload.attachment?.data || payload.attachmentTemplate) {
      attachmentDirectory = fs.mkdtempSync(
        path.join(app.getPath('temp'), 'mail-system-api-')
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

    // Validate the account and refresh its token once before starting the batch.
    // Reusing this token keeps sequential API sending fast without changing
    // the delay selected by the user.
    const accessToken = await getGmailAccessToken(payload.gmailAccountId)
    const delayMilliseconds =
      Math.max(Number(payload.delaySeconds) || 0, 0) * 1000

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
      const templateContext = createTemplateContext(
        row,
        payload.customVariables || {}
      )
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

        const subject = expandTemplate(
          payload.subject || '',
          row,
          templateContext
        )
        const body = expandTemplate(payload.body || '', row, templateContext)
        const message = createMimeMessage({
          recipient: email,
          subject,
          body,
          htmlMode: Boolean(payload.htmlMode || looksLikeHtml(body)),
          attachmentPath: recipientAttachmentPath,
        })

        await sendGmailApiMessage(
          payload.gmailAccountId,
          message,
          accessToken
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

      if (delayMilliseconds > 0 && processed < recipients.length) {
        await wait(delayMilliseconds)
      }
    }

    emitProgress({
      status:
        failed > (Number(payload.baseFailed) || 0) &&
        sent === (Number(payload.baseSent) || 0)
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
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      fs.unlinkSync(attachmentPath)
    }
    if (attachmentDirectory && fs.existsSync(attachmentDirectory)) {
      fs.rmSync(attachmentDirectory, { recursive: true, force: true })
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
      editAs: 'absolute',
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
  let directory

  try {
    directory = fs.mkdtempSync(path.join(app.getPath('temp'), 'mail-heic-'))
    const data = await convertPngBufferToHeic(
      Buffer.from(new Uint8Array(payload.data)),
      directory
    )

    return {
      success: true,
      data,
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

ipcMain.handle(
  'open-chrome-profile',
  async (_event, profileId, port, launchId = '', freshProfile = false) => {
    try {
      const chromePath = getChromePath()
      if (!chromePath) {
        throw new Error('Google Chrome not found.')
      }

      fs.mkdirSync(profilesRoot, { recursive: true })

      // Every panel Open creates a new isolated Chrome data directory. This
      // intentionally discards the previous profile's cookies so the user
      // gets a fresh Gmail login each time.
      const safeLaunchId =
        String(launchId)
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .slice(0, 80) || randomId().toLowerCase()
      const profileFolder = freshProfile
        ? `profile-${String(profileId)}-session-${safeLaunchId}`
        : `profile-${String(profileId)}`
      const profileDir = path.join(profilesRoot, profileFolder)

      fs.mkdirSync(profileDir, { recursive: true })

      // Unique debugging port for each profile.
      const debugPort = Number(port) || 9222
      try {
        const existingChrome = await fetch(
          `http://127.0.0.1:${debugPort}/json/version`,
          { signal: AbortSignal.timeout(800) }
        )
        if (existingChrome.ok) {
          throw new Error(
            'Close the currently open Chrome profile before opening a fresh one.'
          )
        }
      } catch (error) {
        if (/Close the currently open Chrome profile/.test(error.message)) {
          throw error
        }
        // No browser is listening on this profile's debugging port.
      }

      const gmailUrl = `https://mail.google.com/mail/u/0/?mail_system_window=${encodeURIComponent(
        safeLaunchId
      )}#inbox`

      const chromeArgs = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${debugPort}`,
        '--no-first-run',
        '--no-default-browser-check',
        // Always request a separate top-level Chrome window. The unique data
        // directory above prevents Chrome from reusing an old Gmail session.
        '--new-window',
        ...backgroundAutomationChromeArgs,
        gmailUrl,
      ]

      // macOS can route a direct Chrome executable launch into the already
      // running instance. `open -na` forces a new Chrome app instance so each
      // isolated user-data-dir stays attached to its own sender profile.
      const macLauncher = '/usr/bin/open'
      const useMacLauncher =
        process.platform === 'darwin' && fs.existsSync(macLauncher)
      const launchCommand = useMacLauncher ? macLauncher : chromePath
      const launchArgs = useMacLauncher
        ? ['-na', '/Applications/Google Chrome.app', '--args', ...chromeArgs]
        : chromeArgs

      const chrome = spawn(launchCommand, launchArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: process.platform === 'win32',
      })

      chrome.unref()

      return {
        success: true,
        profileId,
        port: debugPort,
        freshProfile: Boolean(freshProfile),
      }
    } catch (error) {
      console.error('[Chrome] Launch failed:', error)

      return {
        success: false,
        error: error.message,
      }
    }
  }
)

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
