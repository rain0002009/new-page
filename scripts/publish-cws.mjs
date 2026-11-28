import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const DEFAULT_EXTENSION_ID = 'fonjkepbgbaijaghboomgbkpohhopomm'
export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/chromewebstore'
export const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const CWS_API_BASE = 'https://chromewebstore.googleapis.com'
export const CWS_API_VERSION = '2'

const CONFIG_KEYS = [
  'CWS_CLIENT_ID',
  'CWS_CLIENT_SECRET',
  'CWS_REFRESH_TOKEN',
  'CWS_PUBLISHER_ID',
  'CWS_EXTENSION_ID',
]

export function getHelpText() {
  return [
    'Usage: node scripts/publish-cws.mjs [options]',
    '',
    'Chrome Web Store API v2 helper for Page Garden.',
    '',
    'Options:',
    '  --zip <path>     Path to extension ZIP (default: dist/page-garden-<version>.zip)',
    '  --dry-run        Validate ZIP and print planned API requests without network calls',
    '  --upload-only    Upload ZIP package only without submitting for publish (default)',
    '  --publish        Upload ZIP package and submit for Chrome Web Store review',
    '  --status         Fetch current item status via :fetchStatus',
    '  --auth           Start local loopback OAuth2 server to obtain CWS_REFRESH_TOKEN',
    '  --port <port>    Loopback port for --auth (default: 0, ephemeral port)',
    '  -h, --help       Show this help message',
    '',
    'Environment (.env.local or process.env; process.env takes precedence):',
    '  CWS_CLIENT_ID       Google OAuth2 client ID',
    '  CWS_CLIENT_SECRET   Google OAuth2 client secret',
    '  CWS_REFRESH_TOKEN   OAuth2 refresh token (obtain with --auth)',
    '  CWS_PUBLISHER_ID    Chrome Web Store publisher ID',
    `  CWS_EXTENSION_ID    Extension item ID (default: ${DEFAULT_EXTENSION_ID})`,
    '',
    'Examples:',
    '  node scripts/publish-cws.mjs --dry-run --zip ../dist/page-garden-1.6.1.zip',
    '  node scripts/publish-cws.mjs --auth',
    '  node scripts/publish-cws.mjs --status',
    '  node scripts/publish-cws.mjs --upload-only',
    '  node scripts/publish-cws.mjs --publish',
  ].join('\n')
}

export function parseArgs(argv) {
  const options = {
    help: false,
    dryRun: false,
    uploadOnly: false,
    publish: false,
    status: false,
    auth: false,
    zip: null,
    port: 0,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--upload-only') {
      options.uploadOnly = true
    } else if (arg === '--publish') {
      options.publish = true
    } else if (arg === '--status') {
      options.status = true
    } else if (arg === '--auth') {
      options.auth = true
    } else if (arg === '--zip' || arg.startsWith('--zip=')) {
      const value = arg === '--zip' ? argv[++i] : arg.slice('--zip='.length)
      if (!value) throw new Error('Missing value for --zip')
      options.zip = value
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const raw = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      if (raw === undefined || raw === '') throw new Error('Missing value for --port')
      const port = Number(raw)
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`Invalid port number: ${raw}`)
      }
      options.port = port
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  const modeFlags = [options.uploadOnly, options.publish, options.status, options.auth].filter(Boolean)
  if (modeFlags.length > 1) {
    throw new Error('Flags --upload-only, --publish, --status, and --auth are mutually exclusive.')
  }

  return options
}

export function parseEnvContent(content) {
  const parsed = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const line = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed
    const eqIndex = line.indexOf('=')
    if (eqIndex <= 0) continue

    const key = line.slice(0, eqIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = line.slice(eqIndex + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\"/g, '"')
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1)
    } else {
      const commentIndex = value.indexOf(' #')
      if (commentIndex !== -1) value = value.slice(0, commentIndex).trim()
    }

    parsed[key] = value
  }
  return parsed
}

export function loadConfig({ rootDir = repoRoot, env = process.env, envFile = '.env.local' } = {}) {
  const envPath = join(rootDir, envFile)
  const fileEnv = existsSync(envPath) ? parseEnvContent(readFileSync(envPath, 'utf8')) : {}
  const resolved = {}

  for (const key of CONFIG_KEYS) {
    const fromProcess = env[key]
    resolved[key] = fromProcess !== undefined && fromProcess !== '' ? fromProcess : (fileEnv[key] ?? '')
  }

  const extensionIdFromConfig = resolved.CWS_EXTENSION_ID.trim()
  return {
    clientId: resolved.CWS_CLIENT_ID.trim(),
    clientSecret: resolved.CWS_CLIENT_SECRET.trim(),
    refreshToken: resolved.CWS_REFRESH_TOKEN.trim(),
    publisherId: resolved.CWS_PUBLISHER_ID.trim(),
    extensionId: extensionIdFromConfig || DEFAULT_EXTENSION_ID,
    extensionIdSource: extensionIdFromConfig ? 'env' : 'default',
    envFileLoaded: existsSync(envPath) ? envPath : null,
  }
}

export function getMissingConfigKeys(config, requiredFields) {
  const fieldToEnv = {
    clientId: 'CWS_CLIENT_ID',
    clientSecret: 'CWS_CLIENT_SECRET',
    refreshToken: 'CWS_REFRESH_TOKEN',
    publisherId: 'CWS_PUBLISHER_ID',
    extensionId: 'CWS_EXTENSION_ID',
  }
  return requiredFields.filter(field => !config[field]).map(field => fieldToEnv[field])
}

export function resolveDefaultZipPath(rootDir = repoRoot) {
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  if (!pkg.version) throw new Error('Missing version in package.json')
  return join(rootDir, 'dist', `page-garden-${pkg.version}.zip`)
}

export function resolveZipPath(zipOption, { rootDir = repoRoot, cwd = process.cwd() } = {}) {
  if (!zipOption) return resolveDefaultZipPath(rootDir)
  return isAbsolute(zipOption) ? resolve(zipOption) : resolve(cwd, zipOption)
}

function readZipEntryBuffer(zipBuffer, entryName) {
  let eocdOffset = -1
  const minOffset = Math.max(0, zipBuffer.length - 65557)
  for (let offset = zipBuffer.length - 22; offset >= minOffset; offset -= 1) {
    if (zipBuffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset
      break
    }
  }
  if (eocdOffset === -1) return null

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10)
  let cursor = zipBuffer.readUInt32LE(eocdOffset + 16)

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory.')
    }
    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10)
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20)
    const fileNameLength = zipBuffer.readUInt16LE(cursor + 28)
    const extraLength = zipBuffer.readUInt16LE(cursor + 30)
    const commentLength = zipBuffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42)
    const name = zipBuffer.subarray(cursor + 46, cursor + 46 + fileNameLength).toString('utf8')

    if (name === entryName) {
      if (localHeaderOffset + 30 > zipBuffer.length || zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`Corrupt local header for ${entryName}.`)
      }
      const localNameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26)
      const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28)
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
      if (dataStart + compressedSize > zipBuffer.length) {
        throw new Error(`Corrupt ZIP entry bounds for ${entryName}.`)
      }
      const compressedData = zipBuffer.subarray(dataStart, dataStart + compressedSize)

      if (compressionMethod === 0) return compressedData
      if (compressionMethod === 8) return inflateRawSync(compressedData)
      throw new Error(`Unsupported ZIP compression method (${compressionMethod}) for ${entryName}.`)
    }

    cursor += 46 + fileNameLength + extraLength + commentLength
  }

  return null
}

export function inspectZipPackage(zipPath) {
  if (!existsSync(zipPath)) {
    throw new Error(`Extension ZIP not found: ${zipPath}. Run "pnpm build:chrome && pnpm package:chrome" or pass --zip <path>.`)
  }
  const stat = statSync(zipPath)
  if (!stat.isFile()) {
    throw new Error(`ZIP path is not a file: ${zipPath}`)
  }

  const buffer = readFileSync(zipPath)
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error(`Invalid ZIP archive: ${zipPath}`)
  }

  const manifestBuffer = readZipEntryBuffer(buffer, 'manifest.json')
  if (!manifestBuffer) {
    throw new Error(`ZIP archive is missing manifest.json: ${zipPath}`)
  }

  const manifest = JSON.parse(manifestBuffer.toString('utf8'))
  if (manifest.manifest_version !== 3 || !manifest.version) {
    throw new Error(`Expected a Manifest V3 manifest.json with a version in ${zipPath}`)
  }

  return {
    path: zipPath,
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    buffer,
    manifest: {
      name: manifest.name ?? '',
      version: manifest.version,
      manifestVersion: manifest.manifest_version,
    },
  }
}

export function buildEndpoints({ publisherId, extensionId }) {
  const pub = publisherId ? encodeURIComponent(publisherId) : '<CWS_PUBLISHER_ID>'
  const item = encodeURIComponent(extensionId || DEFAULT_EXTENSION_ID)
  return {
    token: OAUTH_TOKEN_URL,
    upload: `${CWS_API_BASE}/upload/v2/publishers/${pub}/items/${item}:upload`,
    publish: `${CWS_API_BASE}/v2/publishers/${pub}/items/${item}:publish`,
    fetchStatus: `${CWS_API_BASE}/v2/publishers/${pub}/items/${item}:fetchStatus`,
  }
}

export function buildDryRunReport({ options, config, zipInfo }) {
  const endpoints = buildEndpoints(config)
  const requiredFields = options.auth
    ? ['clientId', 'clientSecret']
    : ['clientId', 'clientSecret', 'refreshToken', 'publisherId', 'extensionId']
  const missing = getMissingConfigKeys(config, requiredFields)

  const requests = []
  if (options.auth) {
    requests.push({
      step: 'authorize',
      method: 'GET',
      url: OAUTH_AUTHORIZE_URL,
      scope: OAUTH_SCOPE,
      redirectUri: `http://127.0.0.1:${options.port || '<ephemeral>'}/callback`,
    })
    requests.push({
      step: 'exchange_token',
      method: 'POST',
      url: endpoints.token,
    })
  } else {
    requests.push({
      step: 'refresh_token',
      method: 'POST',
      url: endpoints.token,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    })
    if (options.status) {
      requests.push({
        step: 'fetch_status',
        method: 'GET',
        url: endpoints.fetchStatus,
        headers: {
          Authorization: 'Bearer <redacted>',
          'x-goog-api-version': CWS_API_VERSION,
        },
      })
    } else {
      requests.push({
        step: 'upload',
        method: 'POST',
        url: endpoints.upload,
        headers: {
          Authorization: 'Bearer <redacted>',
          'x-goog-api-version': CWS_API_VERSION,
          'Content-Type': 'application/zip',
        },
        bodyBytes: zipInfo.sizeBytes,
      })
      if (options.publish) {
        requests.push({
          step: 'publish',
          method: 'POST',
          url: endpoints.publish,
          headers: {
            Authorization: 'Bearer <redacted>',
            'x-goog-api-version': CWS_API_VERSION,
            'Content-Type': 'application/json',
          },
          body: '{}',
        })
      }
    }
  }

  return {
    dryRun: true,
    mode: options.auth ? 'auth' : options.status ? 'status' : options.publish ? 'upload+publish' : 'upload-only',
    config: {
      envFileLoaded: config.envFileLoaded,
      CWS_CLIENT_ID: config.clientId ? 'set' : 'MISSING',
      CWS_CLIENT_SECRET: config.clientSecret ? 'set (redacted)' : 'MISSING',
      CWS_REFRESH_TOKEN: config.refreshToken ? 'set (redacted)' : 'MISSING',
      CWS_PUBLISHER_ID: config.publisherId || 'MISSING',
      CWS_EXTENSION_ID: `${config.extensionId} (${config.extensionIdSource})`,
      missingForLiveRun: missing,
    },
    ...(zipInfo
      ? {
          zip: {
            path: zipInfo.path,
            sizeBytes: zipInfo.sizeBytes,
            sha256: zipInfo.sha256,
            manifest: zipInfo.manifest,
          },
        }
      : {}),
    requests,
  }
}

async function parseApiResponse(response) {
  const text = await response.text()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

export async function refreshAccessToken(config, fetchImpl = fetch) {
  const missing = getMissingConfigKeys(config, ['clientId', 'clientSecret', 'refreshToken'])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`)
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  })

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const payload = await parseApiResponse(response)
  if (!response.ok || !payload.access_token) {
    const detail = payload.error_description || payload.error || payload.raw || `HTTP ${response.status}`
    throw new Error(`OAuth token refresh failed: ${detail}`)
  }
  return payload.access_token
}

export async function fetchExtensionStatus({ publisherId, extensionId, accessToken }, fetchImpl = fetch) {
  const endpoints = buildEndpoints({ publisherId, extensionId })
  const response = await fetchImpl(endpoints.fetchStatus, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-api-version': CWS_API_VERSION,
    },
  })
  const payload = await parseApiResponse(response)
  if (!response.ok) {
    const detail = payload.error?.message || payload.raw || `HTTP ${response.status}`
    throw new Error(`Fetch status failed (${response.status}): ${detail}`)
  }
  return payload
}

export async function uploadExtensionZip({ publisherId, extensionId, accessToken, zipBuffer }, fetchImpl = fetch) {
  const endpoints = buildEndpoints({ publisherId, extensionId })
  const response = await fetchImpl(endpoints.upload, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-api-version': CWS_API_VERSION,
      'Content-Type': 'application/zip',
    },
    body: zipBuffer,
  })
  const payload = await parseApiResponse(response)
  if (!response.ok) {
    const detail = payload.error?.message || payload.raw || `HTTP ${response.status}`
    throw new Error(`Upload failed (${response.status}): ${detail}`)
  }
  if (payload.uploadState === 'FAILED') {
    throw new Error(`Upload failed: ${JSON.stringify(payload)}`)
  }
  return payload
}

export async function waitForUploadCompletion(
  { publisherId, extensionId, accessToken },
  { fetchImpl = fetch, maxAttempts = 10, intervalMs = 3000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {},
) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0 && intervalMs > 0) await sleep(intervalMs)
    const status = await fetchExtensionStatus({ publisherId, extensionId, accessToken }, fetchImpl)
    const state = status.lastAsyncUploadState
    if (state === 'SUCCEEDED') return status
    if (state === 'FAILED') {
      throw new Error(`Async upload processing failed: ${JSON.stringify(status)}`)
    }
  }
  throw new Error('Timed out waiting for Chrome Web Store upload processing to complete.')
}

export async function publishExtension({ publisherId, extensionId, accessToken }, fetchImpl = fetch) {
  const endpoints = buildEndpoints({ publisherId, extensionId })
  const response = await fetchImpl(endpoints.publish, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-api-version': CWS_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  const payload = await parseApiResponse(response)
  if (!response.ok) {
    const detail = payload.error?.message || payload.raw || `HTTP ${response.status}`
    throw new Error(`Publish failed (${response.status}): ${detail}`)
  }
  return payload
}

export function createPkcePair() {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

export async function exchangeAuthCode({ clientId, clientSecret, code, codeVerifier, redirectUri }, fetchImpl = fetch) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    code_verifier: codeVerifier,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  })

  const response = await fetchImpl(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  const payload = await parseApiResponse(response)
  if (!response.ok || !payload.refresh_token) {
    const detail = payload.error_description || payload.error || payload.raw || (response.ok ? 'No refresh_token returned' : `HTTP ${response.status}`)
    throw new Error(`OAuth code exchange failed: ${detail}`)
  }
  return payload
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
}

export async function runAuthFlow({ config, port = 0, fetchImpl = fetch, timeoutMs = 300000, onReady }) {
  const missing = getMissingConfigKeys(config, ['clientId', 'clientSecret'])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s) for --auth: ${missing.join(', ')}`)
  }

  const state = randomBytes(16).toString('hex')
  const { codeVerifier, codeChallenge } = createPkcePair()

  return await new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    let timer
    const server = createServer(async (req, res) => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : port
      const requestUrl = new URL(req.url || '/', `http://127.0.0.1:${boundPort}`)

      if (requestUrl.pathname !== '/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not found')
        return
      }

      const error = requestUrl.searchParams.get('error')
      const returnedState = requestUrl.searchParams.get('state')
      const code = requestUrl.searchParams.get('code')

      const finish = (err, tokens) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        server.close(() => {
          if (err) rejectPromise(err)
          else resolvePromise(tokens)
        })
      }

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h1>Authorization failed</h1><p>${escapeHtml(error)}</p>`)
        finish(new Error(`OAuth authorization failed: ${error}`))
        return
      }

      if (returnedState !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>Invalid OAuth callback</h1><p>Missing code or state mismatch.</p>')
        finish(new Error('OAuth callback state mismatch or missing authorization code.'))
        return
      }

      try {
        const redirectUri = `http://127.0.0.1:${boundPort}/callback`
        const tokens = await exchangeAuthCode(
          {
            clientId: config.clientId,
            clientSecret: config.clientSecret,
            code,
            codeVerifier,
            redirectUri,
          },
          fetchImpl,
        )
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end('<h1>Chrome Web Store OAuth complete</h1><p>You can close this tab and return to the terminal.</p>')
        finish(null, tokens)
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<h1>Token exchange failed</h1><p>${escapeHtml(err.message)}</p>`)
        finish(err)
      }
    })

    server.on('error', err => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        rejectPromise(err)
      }
    })

    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : port
      const redirectUri = `http://127.0.0.1:${boundPort}/callback`
      const authUrl = buildAuthUrl({
        clientId: config.clientId,
        redirectUri,
        state,
        codeChallenge,
      })

      if (onReady) {
        onReady({ authUrl, redirectUri, state, port: boundPort })
      } else {
        console.log('Open this URL in Chrome to authorize Chrome Web Store access:\n')
        console.log(`  ${authUrl}\n`)
        console.log(`Waiting for OAuth2 callback on ${redirectUri} ...`)
      }

      timer = setTimeout(() => {
        if (!settled) {
          settled = true
          server.close(() => rejectPromise(new Error('Timed out waiting for OAuth2 callback.')))
        }
      }, timeoutMs)
    })
  })
}

export async function runCli(argv, deps = {}) {
  const options = parseArgs(argv)
  if (options.help) {
    console.log(getHelpText())
    return
  }

  const rootDir = deps.rootDir ?? repoRoot
  const config = loadConfig({ rootDir, env: deps.env ?? process.env })
  const fetchImpl = deps.fetchImpl ?? fetch

  let zipInfo = null
  if (!options.auth && !options.status) {
    const zipPath = resolveZipPath(options.zip, { rootDir, cwd: deps.cwd ?? process.cwd() })
    zipInfo = inspectZipPackage(zipPath)
  }

  if (options.dryRun) {
    const report = buildDryRunReport({ options, config, zipInfo })
    console.log(JSON.stringify(report, null, 2))
    return
  }

  if (options.auth) {
    const tokens = await runAuthFlow({ config, port: options.port, fetchImpl })
    console.log('\nAdd this to .env.local (never commit .env.local):')
    console.log(`CWS_REFRESH_TOKEN=${tokens.refresh_token}`)
    return
  }

  const missing = getMissingConfigKeys(config, ['clientId', 'clientSecret', 'refreshToken', 'publisherId', 'extensionId'])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(', ')}`)
  }

  const accessToken = await refreshAccessToken(config, fetchImpl)

  if (options.status) {
    const status = await fetchExtensionStatus(
      { publisherId: config.publisherId, extensionId: config.extensionId, accessToken },
      fetchImpl,
    )
    console.log(JSON.stringify(status, null, 2))
    return
  }

  const uploadResult = await uploadExtensionZip(
    {
      publisherId: config.publisherId,
      extensionId: config.extensionId,
      accessToken,
      zipBuffer: zipInfo.buffer,
    },
    fetchImpl,
  )
  console.log('Upload response:')
  console.log(JSON.stringify(uploadResult, null, 2))

  if (options.publish) {
    if (uploadResult.uploadState === 'UPLOAD_IN_PROGRESS' || uploadResult.uploadState === 'IN_PROGRESS') {
      await waitForUploadCompletion(
        { publisherId: config.publisherId, extensionId: config.extensionId, accessToken },
        { fetchImpl },
      )
    }
    const publishResult = await publishExtension(
      { publisherId: config.publisherId, extensionId: config.extensionId, accessToken },
      fetchImpl,
    )
    console.log('Publish response:')
    console.log(JSON.stringify(publishResult, null, 2))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(`Chrome Web Store publish error: ${error.message}`)
    process.exitCode = 1
  })
}
