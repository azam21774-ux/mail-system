import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const binDirectory = join(process.cwd(), 'node_modules', '.bin')
const bin = (name) =>
  join(binDirectory, process.platform === 'win32' ? `${name}.cmd` : name)

const vitePath = bin('vite')
const electronPath = bin('electron')

if (!existsSync(vitePath) || !existsSync(electronPath)) {
  console.error(
    'Dependencies are incomplete. Run "npm install" again, then run "npm run dev".'
  )
  process.exit(1)
}

const children = []
let shuttingDown = false

function start(command, args) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, BROWSER: 'none' },
  })
  children.push(child)

  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      shutdown(signal ? 1 : code ?? 0)
    }
  })

  return child
}

function waitForPort(port, timeoutMs = 30000) {
  const startedAt = Date.now()

  return new Promise((resolve, reject) => {
    const probe = () => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for port ${port}.`))
        } else {
          setTimeout(probe, 250)
        }
      })
    }

    probe()
  })
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  setTimeout(() => process.exit(code), 250)
}

process.on('SIGINT', () => shutdown())
process.on('SIGTERM', () => shutdown())

start(vitePath, ['--host', '0.0.0.0', '--port', '5173'])

try {
  await waitForPort(5173)
  start(electronPath, ['.'])
} catch (error) {
  console.error(error.message)
  shutdown(1)
}