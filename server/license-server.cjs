const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { Pool } = require('pg')

const PORT = Number(process.env.PORT || 5000)
const HOST = process.env.HOST || '0.0.0.0'
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const ADMIN_USERNAME = process.env.LICENSE_ADMIN_USERNAME || 'admin'
const ADMIN_PASSWORD = process.env.LICENSE_ADMIN_PASSWORD || ''
const TOKEN_SECRET =
  process.env.LICENSE_TOKEN_SECRET || process.env.SESSION_SECRET || ''

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required to run the license server.')
  process.exit(1)
}

if (!ADMIN_PASSWORD) {
  console.error(
    'LICENSE_ADMIN_PASSWORD is required. Add it as a Replit Secret before starting the admin server.'
  )
  process.exit(1)
}

if (!TOKEN_SECRET) {
  console.error(
    'LICENSE_TOKEN_SECRET or SESSION_SECRET is required to sign license sessions.'
  )
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adminFile = path.join(__dirname, 'admin.html')

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function html(response, statusCode, content) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(content)
}

function text(response, statusCode, content) {
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(content)
}

function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf('=')
        return separator === -1
          ? [part, '']
          : [
              decodeURIComponent(part.slice(0, separator)),
              decodeURIComponent(part.slice(separator + 1)),
            ]
      })
  )
}

function sign(value) {
  return crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(value)
    .digest('base64url')
}

function createAdminSession() {
  const payload = `${ADMIN_USERNAME}.${Date.now()}.${crypto.randomBytes(18).toString('hex')}`
  return `${payload}.${sign(payload)}`
}

function isAdminSessionValid(request) {
  const value = parseCookies(request).mail_admin_session
  if (!value) return false

  const parts = value.split('.')
  if (parts.length !== 4) return false
  const signature = parts.pop()
  const payload = parts.join('.')
  const timestamp = Number(parts[1])

  if (
    !Number.isFinite(timestamp) ||
    Date.now() - timestamp > SESSION_TTL_MS ||
    Date.now() < timestamp
  ) {
    return false
  }

  const expected = sign(payload)
  return (
    signature.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  )
}

function licenseHash(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || '').trim().toUpperCase())
    .digest('hex')
}

function createLicenseKey() {
  const chunks = Array.from({ length: 3 }, () =>
    crypto.randomBytes(3).toString('hex').toUpperCase()
  )
  return `MM-${chunks.join('-')}`
}

function createLicenseToken(license) {
  const payload = {
    licenseId: license.id,
    username: license.username,
    expiresAt: new Date(license.expires_at).toISOString(),
    deviceId: license.device_id || null,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 64 * 1024) {
        reject(new Error('Request body is too large.'))
        request.destroy()
      }
    })
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('Request body must be valid JSON.'))
      }
    })
    request.on('error', reject)
  })
}

function sanitizeLicense(row, includeKey = false) {
  return {
    id: row.id,
    username: row.username,
    licenseKey: includeKey ? row.license_key : undefined,
    licenseKeyLast4: row.license_key_last4,
    status: row.status,
    durationHours: row.duration_hours,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    activationCount: row.activation_count,
  }
}

function requireAdmin(request, response) {
  if (isAdminSessionValid(request)) return true
  json(response, 401, { error: 'Admin login required.' })
  return false
}

async function listLicenses() {
  const result = await pool.query(`
    SELECT id, username, license_key_last4, status, duration_hours,
           created_at, activated_at, expires_at, revoked_at, last_seen_at,
           activation_count
    FROM license_users
    ORDER BY created_at DESC
  `)
  return result.rows.map((row) => sanitizeLicense(row))
}

async function handleAdmin(request, response, url) {
  if (request.method === 'POST' && url.pathname === '/api/admin/login') {
    const body = await readJson(request)
    const username = String(body.username || '').trim()
    const password = String(body.password || '')

    if (
      username !== ADMIN_USERNAME ||
      password.length !== ADMIN_PASSWORD.length ||
      !crypto.timingSafeEqual(
        Buffer.from(password),
        Buffer.from(ADMIN_PASSWORD)
      )
    ) {
      json(response, 401, { error: 'Invalid admin credentials.' })
      return
    }

    const session = createAdminSession()
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie': `mail_admin_session=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify({ success: true }))
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/logout') {
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Set-Cookie':
        'mail_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      'Cache-Control': 'no-store',
    })
    response.end(JSON.stringify({ success: true }))
    return
  }

  if (!requireAdmin(request, response)) return

  if (request.method === 'GET' && url.pathname === '/api/admin/session') {
    json(response, 200, { authenticated: true, username: ADMIN_USERNAME })
    return
  }

  if (request.method === 'GET' && url.pathname === '/api/admin/licenses') {
    json(response, 200, { licenses: await listLicenses() })
    return
  }

  if (request.method === 'POST' && url.pathname === '/api/admin/licenses') {
    const body = await readJson(request)
    const username = String(body.username || '').trim()
    const durationHours = Number(body.durationHours)

    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
      json(response, 400, {
        error: 'Username must be 3-64 characters: letters, numbers, dot, underscore or hyphen.',
      })
      return
    }
    if (!Number.isInteger(durationHours) || durationHours < 1 || durationHours > 8760) {
      json(response, 400, { error: 'Duration must be between 1 and 8760 hours.' })
      return
    }

    const licenseKey = createLicenseKey()
    try {
      const result = await pool.query(
        `INSERT INTO license_users
          (username, license_key_hash, license_key_last4, duration_hours)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, license_key_last4, status, duration_hours,
                   created_at, activated_at, expires_at, revoked_at,
                   last_seen_at, activation_count`,
        [
          username,
          licenseHash(licenseKey),
          licenseKey.slice(-4),
          durationHours,
        ]
      )
      json(response, 201, {
        license: {
          ...sanitizeLicense(result.rows[0]),
          licenseKey,
        },
      })
    } catch (error) {
      if (error.code === '23505') {
        json(response, 409, { error: 'That username already exists.' })
      } else {
        throw error
      }
    }
    return
  }

  const actionMatch = url.pathname.match(/^\/api\/admin\/licenses\/(\d+)\/(revoke|delete|extend)$/)
  if (request.method === 'POST' && actionMatch) {
    const [, id, action] = actionMatch
    const body = await readJson(request)

    if (action === 'revoke') {
      const result = await pool.query(
        `UPDATE license_users
         SET status = 'revoked', revoked_at = NOW()
         WHERE id = $1
         RETURNING id`,
        [id]
      )
      if (!result.rowCount) {
        json(response, 404, { error: 'License not found.' })
        return
      }
    } else if (action === 'delete') {
      const result = await pool.query(
        'DELETE FROM license_users WHERE id = $1 RETURNING id',
        [id]
      )
      if (!result.rowCount) {
        json(response, 404, { error: 'License not found.' })
        return
      }
    } else {
      const durationHours = Number(body.durationHours)
      if (
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > 8760
      ) {
        json(response, 400, {
          error: 'Duration must be between 1 and 8760 hours.',
        })
        return
      }

      const result = await pool.query(
        `UPDATE license_users
         SET duration_hours = $2,
             expires_at = CASE
               WHEN expires_at IS NULL OR expires_at < NOW()
                 THEN NOW() + ($2 * INTERVAL '1 hour')
               ELSE expires_at + ($2 * INTERVAL '1 hour')
             END,
             status = 'active',
             revoked_at = NULL
         WHERE id = $1
         RETURNING id`,
        [id, durationHours]
      )
      if (!result.rowCount) {
        json(response, 404, { error: 'License not found.' })
        return
      }
    }

    json(response, 200, { licenses: await listLicenses() })
    return
  }

  json(response, 404, { error: 'Admin route not found.' })
}

async function handleLicense(request, response, url) {
  if (request.method !== 'POST' || !['/api/license/activate', '/api/license/validate'].includes(url.pathname)) {
    json(response, 404, { error: 'License route not found.' })
    return
  }

  const body = await readJson(request)

  if (url.pathname === '/api/license/activate') {
    const username = String(body.username || '').trim()
    const licenseKey = String(body.licenseKey || '').trim().toUpperCase()
    const deviceId = String(body.deviceId || '').trim().slice(0, 200)

    if (!username || !licenseKey || !deviceId) {
      json(response, 400, {
        error: 'Username, license key and device ID are required.',
      })
      return
    }

    const result = await pool.query(
      `SELECT *
       FROM license_users
       WHERE LOWER(username) = LOWER($1)
         AND license_key_hash = $2
       LIMIT 1`,
      [username, licenseHash(licenseKey)]
    )
    const license = result.rows[0]

    if (!license) {
      json(response, 401, { error: 'Username or license key is incorrect.' })
      return
    }
    if (license.status !== 'active') {
      json(response, 403, { error: 'This license has been revoked.' })
      return
    }
    if (license.expires_at && new Date(license.expires_at).getTime() <= Date.now()) {
      json(response, 403, {
        error: 'This license has expired. Ask the administrator to extend it.',
      })
      return
    }

    const update = await pool.query(
      `UPDATE license_users
       SET activated_at = COALESCE(activated_at, NOW()),
           expires_at = COALESCE(expires_at, NOW() + (duration_hours * INTERVAL '1 hour')),
           last_seen_at = NOW(),
           activation_count = activation_count + 1
       WHERE id = $1
       RETURNING *`,
      [license.id]
    )
    const activated = update.rows[0]
    json(response, 200, {
      success: true,
      token: createLicenseToken({ ...activated, device_id: deviceId }),
      username: activated.username,
      expiresAt: activated.expires_at,
    })
    return
  }

  const token = String(body.token || '')
  const [encoded, signature] = token.split('.')
  if (!encoded || !signature || sign(encoded) !== signature) {
    json(response, 401, { error: 'Activation is invalid. Please activate again.' })
    return
  }

  let payload
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    json(response, 401, { error: 'Activation is invalid. Please activate again.' })
    return
  }

  const result = await pool.query(
    `SELECT *
     FROM license_users
     WHERE id = $1 AND LOWER(username) = LOWER($2)
     LIMIT 1`,
    [payload.licenseId, payload.username]
  )
  const license = result.rows[0]
  if (
    !license ||
    license.status !== 'active' ||
    !license.expires_at ||
    new Date(license.expires_at).getTime() <= Date.now()
  ) {
    json(response, 403, { error: 'This license is expired or revoked.' })
    return
  }

  await pool.query(
    'UPDATE license_users SET last_seen_at = NOW() WHERE id = $1',
    [license.id]
  )
  json(response, 200, {
    success: true,
    username: license.username,
    expiresAt: license.expires_at,
  })
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)

  try {
    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/admin')) {
      html(response, 200, fs.readFileSync(adminFile, 'utf8'))
      return
    }

    if (url.pathname.startsWith('/api/admin/')) {
      await handleAdmin(request, response, url)
      return
    }

    if (url.pathname.startsWith('/api/license/')) {
      await handleLicense(request, response, url)
      return
    }

    text(response, 404, 'Not found')
  } catch (error) {
    console.error('[license-server]', error)
    if (!response.headersSent) {
      json(response, 500, { error: 'Unexpected server error.' })
    } else {
      response.end()
    }
  }
})

server.listen(PORT, HOST, () => {
  console.log(`License admin server listening on ${HOST}:${PORT}`)
})

async function shutdown() {
  await pool.end().catch(() => {})
  server.close(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)