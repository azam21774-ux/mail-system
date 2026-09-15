const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const puppeteer = require('puppeteer-core')

const CHROME_PATH =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const profilesRoot = path.join(app.getPath('userData'), 'chrome-profiles')

let mainWindow

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
