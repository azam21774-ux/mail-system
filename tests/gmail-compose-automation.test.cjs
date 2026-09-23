const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const crypto = require('node:crypto')
const puppeteer = require('puppeteer-core')

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    '/repl/tools/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
    process.env.PROGRAMFILES &&
      path.join(
        process.env.PROGRAMFILES,
        'Google',
        'Chrome',
        'Application',
        'chrome.exe'
      ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ]

  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
}

function loadComposeHelpers() {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'electron', 'main.cjs'),
    'utf8'
  )
  const start = source.indexOf('const composeAttachmentSelector')
  const end = source.indexOf('function createWindow()', start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)

  const sandbox = {
    module: { exports: {} },
    exports: {},
    crypto,
    process,
    console,
    setTimeout,
    clearTimeout,
    wait: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  }
  const exportsSource = `
    module.exports = {
      armSendOutcomeObserver,
      clearSendOutcomeObserver,
      discardOwnedCompose,
      getOwnedAttachmentState,
      isOwnedComposeOpen,
      openOwnedCompose,
      ownedComposeSelector,
      composeRecipientSelector,
      waitForComposeClosed,
      waitForSendOutcome,
      waitForVisibleComposeSelector,
    }
  `
  vm.runInNewContext(
    `${source.slice(start, end)}\n${exportsSource}`,
    sandbox,
    { filename: 'gmail-compose-helpers.cjs' }
  )
  return sandbox.module.exports
}

const chromiumPath = findChromium()
const helpers = loadComposeHelpers()

test(
  'owns only the newly opened compose when a stale compose already exists',
  { skip: !chromiumPath },
  async () => {
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    try {
      const page = await browser.newPage()
      await page.setContent(`
        <style>
          button, input, [role="dialog"] { display: block; width: 200px; height: 30px; }
          [role="dialog"] { height: 180px; }
        </style>
        <button aria-label="Compose" id="compose">Compose</button>
        <div role="dialog" id="stale">
          <input name="subjectbox" value="stale">
          <div class="aZo"><button class="aYF" aria-label="Remove attachment"></button></div>
        </div>
      `)
      await page.evaluate(() => {
        document.querySelector('#compose').addEventListener('click', () => {
          const root = document.createElement('div')
          root.id = 'new-compose'
          root.setAttribute('role', 'dialog')
          root.innerHTML = `
            <input name="subjectbox">
            <div role="combobox" aria-label="Recipients" contenteditable="true"></div>
            <div aria-label="Message Body" contenteditable="true"></div>
            <button command="discard" aria-label="Discard draft">Discard</button>
          `
          root.querySelector('[command="discard"]').addEventListener(
            'click',
            () => root.remove()
          )
          document.body.append(root)
        })
      })

      const token = 'owned-compose-test'
      const { compose } = await helpers.openOwnedCompose(page, token)
      const ownedId = await compose.evaluate((element) => element.id)
      assert.equal(ownedId, 'new-compose')
      assert.equal(
        await page.$eval('#stale', (element) =>
          element.hasAttribute('data-mail-system-compose')
        ),
        false
      )
      assert.equal(await helpers.discardOwnedCompose(page, token), true)
      assert.equal(await helpers.isOwnedComposeOpen(page, token), false)
    } finally {
      await browser.close()
    }
  }
)

test(
  'finds Gmail recipient combobox variants inside the owned compose',
  { skip: !chromiumPath },
  async () => {
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    try {
      const page = await browser.newPage()
      await page.setContent(`
        <style>
          [role="dialog"], [role="combobox"] {
            display: block;
            width: 240px;
            height: 30px;
          }
        </style>
        <div role="dialog">
          <div role="combobox" aria-label="Recipients" contenteditable="true"></div>
        </div>
      `)
      const compose = await page.$('[role="dialog"]')
      const recipient = await helpers.waitForVisibleComposeSelector(
        compose,
        helpers.composeRecipientSelector
      )
      assert.equal(
        await recipient.evaluate((element) => element.getAttribute('aria-label')),
        'Recipients'
      )
      await recipient.click()
      await recipient.focus()
      await recipient.type('recipient@example.com')
      assert.equal(
        await recipient.evaluate((element) => element.textContent),
        'recipient@example.com'
      )
    } finally {
      await browser.close()
    }
  }
)

test(
  'counts canonical attachment rows instead of duplicate controls',
  { skip: !chromiumPath },
  async () => {
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    try {
      const page = await browser.newPage()
      const token = 'attachment-count-test'
      await page.setContent(`
        <style>
          [role="dialog"], button { display: block; width: 200px; height: 30px; }
          [role="dialog"] { height: 180px; }
        </style>
        <div role="dialog" data-mail-system-compose="${token}">
          <input name="subjectbox">
          <div class="aZo" id="attachment-one">
            <button class="aYF" aria-label="Remove attachment"></button>
            <button data-tooltip="Remove attachment"></button>
          </div>
        </div>
      `)

      assert.equal(
        (await helpers.getOwnedAttachmentState(page, token)).attachments,
        1
      )
      await page.$eval(
        `[data-mail-system-compose="${token}"]`,
        (root) => {
          const second = document.createElement('div')
          second.className = 'aZo'
          second.innerHTML =
            '<button class="aYF" aria-label="Remove attachment"></button>'
          root.append(second)
        }
      )
      assert.equal(
        (await helpers.getOwnedAttachmentState(page, token)).attachments,
        2
      )
    } finally {
      await browser.close()
    }
  }
)

test(
  'observes a new send notice and confirms owned compose closure',
  { skip: !chromiumPath },
  async () => {
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    try {
      const page = await browser.newPage()
      const token = 'send-outcome-test'
      await page.setContent(`
        <style>[role="dialog"] { display: block; width: 200px; height: 100px; }</style>
        <div role="dialog" data-mail-system-compose="${token}">
          <input name="subjectbox">
        </div>
      `)
      await helpers.armSendOutcomeObserver(page, token)
      const outcomePromise = helpers.waitForSendOutcome(page, token)
      const closePromise = helpers.waitForComposeClosed(page, token)
      await page.evaluate((composeToken) => {
        document
          .querySelector(`[data-mail-system-compose="${composeToken}"]`)
          .remove()
        const notice = document.createElement('div')
        notice.className = 'vh'
        notice.setAttribute('role', 'status')
        notice.textContent = 'Message sent'
        document.body.append(notice)
      }, token)

      assert.equal(await outcomePromise, 'sent')
      assert.equal(await closePromise, true)
    } finally {
      await browser.close()
    }
  }
)

test(
  'ignores a stale sent notice when an unrelated mutation precedes a send error',
  { skip: !chromiumPath },
  async () => {
    const browser = await puppeteer.launch({
      executablePath: chromiumPath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    })

    try {
      const page = await browser.newPage()
      const token = 'stale-notice-test'
      await page.setContent(`
        <style>.vh, [role="alert"] { display: block; width: 200px; height: 30px; }</style>
        <div class="vh" role="status">Message sent</div>
        <div id="unrelated"></div>
      `)
      await helpers.armSendOutcomeObserver(page, token)
      const outcomePromise = helpers.waitForSendOutcome(page, token)
      await page.evaluate(() => {
        document.querySelector('#unrelated').append(
          document.createElement('span')
        )
        const error = document.createElement('div')
        error.setAttribute('role', 'alert')
        error.textContent = "Couldn't send message"
        document.body.append(error)
      })

      assert.equal(await outcomePromise, 'error')
    } finally {
      await browser.close()
    }
  }
)