import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createZip } from './prepare-chrome-store.mjs'
import {
  DEFAULT_EXTENSION_ID,
  OAUTH_SCOPE,
  buildDryRunReport,
  inspectZipPackage,
  loadConfig,
  parseArgs,
  parseEnvContent,
  resolveZipPath,
  runAuthFlow,
  runCli,
  upsertEnvVar,
} from './publish-cws.mjs'

function makeTempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cws-publish-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function makeZipFile(dir, version = '1.6.1') {
  const manifest = {
    manifest_version: 3,
    name: '页墟 · Page Garden',
    version,
  }
  const zipBytes = createZip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
    { name: 'background.js', data: Buffer.from('console.log("ok")') },
  ])
  const zipPath = join(dir, `page-garden-${version}.zip`)
  writeFileSync(zipPath, zipBytes)
  return { zipPath, zipBytes, manifest }
}

test('parseArgs parses flags and rejects conflicting modes or invalid values', () => {
  assert.deepEqual(parseArgs([]), {
    help: false,
    dryRun: false,
    uploadOnly: false,
    publish: false,
    status: false,
    auth: false,
    noOpen: false,
    zip: null,
    port: 0,
  })
  assert.deepEqual(parseArgs(['--dry-run', '--publish', '--zip', 'out.zip']), {
    help: false,
    dryRun: true,
    uploadOnly: false,
    publish: true,
    status: false,
    auth: false,
    noOpen: false,
    zip: 'out.zip',
    port: 0,
  })
  const authOpts = parseArgs(['--auth', '--no-open', '--port=43123'])
  assert.equal(authOpts.port, 43123)
  assert.equal(authOpts.noOpen, true)
  assert.throws(() => parseArgs(['--upload-only', '--publish']), /mutually exclusive/)
  assert.throws(() => parseArgs(['--status', '--auth']), /mutually exclusive/)
  assert.throws(() => parseArgs(['--zip']), /Missing value/)
  assert.throws(() => parseArgs(['--port', '99999']), /Invalid port/)
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/)
})

test('parseEnvContent and loadConfig load .env.local with process.env precedence', t => {
  const dir = makeTempDir(t)
  writeFileSync(
    join(dir, '.env.local'),
    [
      '# comment',
      'CWS_CLIENT_ID="file-client-id"',
      "CWS_CLIENT_SECRET='file-secret'",
      'export CWS_REFRESH_TOKEN=file-refresh # inline comment',
      'CWS_PUBLISHER_ID=pub-123',
    ].join('\n'),
  )

  const parsed = parseEnvContent('A=1\nB="two"\n')
  assert.deepEqual(parsed, { A: '1', B: 'two' })

  const loaded = loadConfig({
    rootDir: dir,
    env: { CWS_CLIENT_ID: 'env-client-id' },
  })
  assert.equal(loaded.clientId, 'env-client-id')
  assert.equal(loaded.clientSecret, 'file-secret')
  assert.equal(loaded.refreshToken, 'file-refresh')
  assert.equal(loaded.publisherId, 'pub-123')
  assert.equal(loaded.extensionId, DEFAULT_EXTENSION_ID)
  assert.equal(loaded.extensionIdSource, 'default')
})

test('resolveZipPath and inspectZipPackage validate manifest and compute sha256', t => {
  const dir = makeTempDir(t)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.6.0' }))
  assert.equal(resolveZipPath(null, { rootDir: dir }), join(dir, 'dist', 'page-garden-1.6.0.zip'))

  const { zipPath, zipBytes } = makeZipFile(dir, '1.6.1')
  const info = inspectZipPackage(zipPath)
  assert.equal(info.sizeBytes, zipBytes.length)
  assert.equal(info.manifest.version, '1.6.1')
  assert.equal(info.manifest.manifestVersion, 3)

  const nonZip = join(dir, 'bad.zip')
  writeFileSync(nonZip, 'not-a-zip')
  assert.throws(() => inspectZipPackage(nonZip), /Invalid ZIP archive/)
})

test('buildDryRunReport redacts secrets and emits expected CWS v2 endpoints', t => {
  const dir = makeTempDir(t)
  const { zipPath } = makeZipFile(dir, '1.6.1')
  const zipInfo = inspectZipPackage(zipPath)
  const report = buildDryRunReport({
    options: parseArgs(['--dry-run', '--publish']),
    config: {
      clientId: 'cid',
      clientSecret: 'super-secret',
      refreshToken: 'rtoken',
      publisherId: 'pub-99',
      extensionId: 'ext-11',
      extensionIdSource: 'env',
      envFileLoaded: null,
    },
    zipInfo,
  })

  assert.equal(report.mode, 'upload+publish')
  assert.equal(report.config.CWS_CLIENT_SECRET, 'set (redacted)')
  assert.equal(report.config.CWS_REFRESH_TOKEN, 'set (redacted)')
  assert.deepEqual(report.config.missingForLiveRun, [])
  assert.equal(report.requests.length, 3)
  assert.equal(report.requests[1].url, 'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-99/items/ext-11:upload')
  assert.equal(report.requests[1].headers['x-goog-api-version'], '2')
  assert.equal(report.requests[2].url, 'https://chromewebstore.googleapis.com/v2/publishers/pub-99/items/ext-11:publish')
})

test('runCli executes upload-only without calling :publish', async t => {
  const dir = makeTempDir(t)
  const { zipPath } = makeZipFile(dir, '1.6.1')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers })
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 })
    }
    if (url.endsWith(':upload')) {
      return new Response(JSON.stringify({ uploadState: 'SUCCEEDED', crxVersion: '1.6.1' }), { status: 200 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await runCli(['--upload-only', '--zip', zipPath], {
    rootDir: dir,
    fetchImpl,
    env: {
      CWS_CLIENT_ID: 'cid',
      CWS_CLIENT_SECRET: 'csec',
      CWS_REFRESH_TOKEN: 'rtok',
      CWS_PUBLISHER_ID: 'pub-1',
      CWS_EXTENSION_ID: 'ext-1',
    },
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/ext-1:upload')
  assert.equal(calls[1].headers['x-goog-api-version'], '2')
})

test('runCli --publish polls :fetchStatus when upload is in progress then calls :publish', async t => {
  const dir = makeTempDir(t)
  const { zipPath } = makeZipFile(dir, '1.6.1')
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers })
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 })
    }
    if (url.endsWith(':upload')) {
      return new Response(JSON.stringify({ uploadState: 'UPLOAD_IN_PROGRESS' }), { status: 200 })
    }
    if (url.endsWith(':fetchStatus')) {
      return new Response(JSON.stringify({ lastAsyncUploadState: 'SUCCEEDED' }), { status: 200 })
    }
    if (url.endsWith(':publish')) {
      return new Response(JSON.stringify({ state: 'PENDING_REVIEW' }), { status: 200 })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await runCli(['--publish', '--zip', zipPath], {
    rootDir: dir,
    fetchImpl,
    env: {
      CWS_CLIENT_ID: 'cid',
      CWS_CLIENT_SECRET: 'csec',
      CWS_REFRESH_TOKEN: 'rtok',
      CWS_PUBLISHER_ID: 'pub-1',
      CWS_EXTENSION_ID: 'ext-1',
    },
  })

  assert.deepEqual(
    calls.map(c => `${c.method} ${c.url}`),
    [
      'POST https://oauth2.googleapis.com/token',
      'POST https://chromewebstore.googleapis.com/upload/v2/publishers/pub-1/items/ext-1:upload',
      'GET https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/ext-1:fetchStatus',
      'POST https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/ext-1:publish',
    ],
  )
})

test('runCli --status calls :fetchStatus and never uploads', async t => {
  const dir = makeTempDir(t)
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers })
    if (url === 'https://oauth2.googleapis.com/token') {
      return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 })
    }
    return new Response(JSON.stringify({ itemId: 'ext-1' }), { status: 200 })
  }

  await runCli(['--status'], {
    rootDir: dir,
    fetchImpl,
    env: {
      CWS_CLIENT_ID: 'cid',
      CWS_CLIENT_SECRET: 'csec',
      CWS_REFRESH_TOKEN: 'rtok',
      CWS_PUBLISHER_ID: 'pub-1',
      CWS_EXTENSION_ID: 'ext-1',
    },
  })

  assert.equal(calls.length, 2)
  assert.equal(calls[1].method, 'GET')
  assert.equal(calls[1].url, 'https://chromewebstore.googleapis.com/v2/publishers/pub-1/items/ext-1:fetchStatus')
})

test('runAuthFlow completes loopback OAuth2 callback, honors noOpen, and runCli saves CWS_REFRESH_TOKEN silently', async t => {
  const dir = makeTempDir(t)
  const envPath = join(dir, '.env.local')
  writeFileSync(envPath, 'CWS_CLIENT_ID=cid\nCWS_CLIENT_SECRET=csec\nCWS_REFRESH_TOKEN=old-tok\n')

  upsertEnvVar(envPath, 'CWS_REFRESH_TOKEN', 'mid-tok')
  upsertEnvVar(envPath, 'CWS_PUBLISHER_ID', 'pub-1')
  assert.equal(
    readFileSync(envPath, 'utf8'),
    'CWS_CLIENT_ID=cid\nCWS_CLIENT_SECRET=csec\nCWS_REFRESH_TOKEN=mid-tok\nCWS_PUBLISHER_ID=pub-1\n',
  )

  const tokenRequests = []
  const openedUrls = []
  const fetchImpl = async (url, init) => {
    tokenRequests.push({ url, body: init.body })
    return new Response(JSON.stringify({ refresh_token: 'rt-secret-value', access_token: 'at-secret-value' }), { status: 200 })
  }

  const tokensNoOpen = await runAuthFlow({
    config: { clientId: 'cid', clientSecret: 'csec' },
    noOpen: true,
    openBrowser: url => openedUrls.push(url),
    fetchImpl,
    onReady: async ({ authUrl, redirectUri, state }) => {
      const parsedAuth = new URL(authUrl)
      assert.equal(parsedAuth.searchParams.get('scope'), OAUTH_SCOPE)
      assert.equal(parsedAuth.searchParams.get('redirect_uri'), redirectUri)
      const callbackRes = await fetch(`${redirectUri}?code=auth-code-1&state=${state}`)
      assert.equal(callbackRes.status, 200)
    },
  })

  assert.equal(tokensNoOpen.refresh_token, 'rt-secret-value')
  assert.equal(openedUrls.length, 0)
  assert.equal(tokenRequests.length, 1)
  assert.equal(tokenRequests[0].url, 'https://oauth2.googleapis.com/token')

  const logs = []
  const origLog = console.log
  console.log = (...args) => logs.push(args.join(' '))
  try {
    await runCli(['--auth', '--no-open'], {
      rootDir: dir,
      env: {},
      fetchImpl,
      openBrowser: url => openedUrls.push(url),
      onAuthReady: async ({ redirectUri, state }) => {
        const res = await fetch(`${redirectUri}?code=auth-code-2&state=${state}`)
        assert.equal(res.status, 200)
      },
    })
  } finally {
    console.log = origLog
  }

  assert.equal(openedUrls.length, 0)
  assert.ok(!logs.join('\n').includes('rt-secret-value'))
  assert.ok(!logs.join('\n').includes('at-secret-value'))
  assert.ok(readFileSync(envPath, 'utf8').includes('CWS_REFRESH_TOKEN=rt-secret-value\n'))
})
