import { test, expect, chromium, type BrowserContext, type Page, type Locator } from '@playwright/test'
import { createServer, type Server } from 'node:https'
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generate } from 'selfsigned'
import { QuarkFixture } from './quark-fixture'

let server: Server
let origin: string
let unavailable = false
let unsafeWrites = false
let omitGetTag = false
let omitPutTag = false
let rejectNextWrite = false
let suspendDataWrites = false
const files = new Map<string, { body: string; revision: number }>()
const clients: { context: BrowserContext; profile: string }[] = []
const quark = new QuarkFixture()

test.beforeAll(async () => {
  const cert = await generate([{ name: 'commonName', value: 'localhost' }], {
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
  })
  server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
    if (await quark.handle(req, res, origin)) return
    const path = new URL(req.url!, 'https://localhost').pathname
    if (path.startsWith('/web/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<title>${path.endsWith('guide') ? 'UnoCSS 指南' : 'React 文档'}</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"><h1>Test website</h1>`)
      return
    }
    if (unavailable) { res.writeHead(503).end(); return }
    if (req.headers.authorization !== `Basic ${Buffer.from('tester:secret').toString('base64')}`) {
      res.writeHead(401).end(); return
    }
    if (req.method === 'PROPFIND') { res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<multistatus xmlns="DAV:"/>'); return }
    if (req.method === 'MKCOL') { res.writeHead(201).end(); return }
    const file = files.get(path)
    if (req.method === 'GET') {
      if (!file) { res.writeHead(404).end(); return }
      res.writeHead(200, { ...(!omitGetTag ? { ETag: `"${file.revision}"` } : {}), 'Content-Type': 'application/json' }).end(file.body)
      return
    }
    if (req.method === 'PUT') {
      if (path.endsWith('/data-v1.json') && suspendDataWrites) { res.writeHead(503).end(); return }
      if (path.endsWith('/data-v1.json') && rejectNextWrite) { rejectNextWrite = false; res.writeHead(412).end(); return }
      if (!unsafeWrites && ((req.headers['if-none-match'] === '*' && file) ||
          (req.headers['if-match'] && req.headers['if-match'] !== `"${file?.revision}"`))) {
        res.writeHead(412).end(); return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      const revision = (file?.revision ?? 0) + 1
      files.set(path, { body, revision })
      res.writeHead(file ? 204 : 201, !omitPutTag ? { ETag: `"${revision}"` } : {}).end()
      return
    }
    if (req.method === 'DELETE') { files.delete(path); res.writeHead(204).end(); return }
    res.writeHead(405).end()
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  origin = `https://localhost:${(server.address() as { port: number }).port}`
})

test.beforeEach(() => { files.clear(); quark.reset(); unavailable = false; unsafeWrites = false; omitGetTag = false; omitPutTag = false; rejectNextWrite = false; suspendDataWrites = false })
test.afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.context.close()
    await rm(client.profile, { recursive: true, force: true })
  }
})
test.afterAll(async () => { await new Promise<void>(done => server.close(() => done())) })

async function openClient(existingProfile?: string, quarkMode = false) {
  const profile = existingProfile ?? await mkdtemp(join(tmpdir(), 'new-page-e2e-'))
  const extension = join(profile, 'extension')
  await cp(resolve('dist/chrome'), extension, { recursive: true })
  const manifestPath = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  // Replace the built-in Quark hosts with the isolated server. Keep the shipped
  // API permissions unchanged so fresh-install tests cover their initialization.
  expect(manifest.permissions).toEqual(expect.arrayContaining(['webRequest', 'declarativeNetRequestWithHostAccess']))
  expect(manifest.host_permissions).toEqual(expect.arrayContaining(['https://*.quark.cn/*', 'https://*.uc.cn/*', 'https://*.aliyuncs.com/*']))
  manifest.host_permissions = ['https://localhost/*', 'https://*.localhost/*']
  await writeFile(manifestPath, JSON.stringify(manifest))
  // Redirect only the isolated test copy's API origins. Production keeps Quark.
  const backgroundPath = join(extension, 'background/service_worker.js')
  let background = await readFile(backgroundPath, 'utf8')
  for (const host of ['https://drive-pc.quark.cn', 'https://uop.quark.cn', 'https://pan.quark.cn']) background = background.replaceAll(host, origin)
  background = background.replaceAll('https://*.quark.cn/*', 'https://localhost/*').replaceAll('https://*.uc.cn/*', 'https://localhost/*').replaceAll('https://*.aliyuncs.com/*', 'https://*.localhost/*')
  await writeFile(backgroundPath, background)
  const newtabPath = join(extension, 'chrome_url_overrides/newtab.js')
  const newtab = (await readFile(newtabPath, 'utf8')).replaceAll('https://*.quark.cn/*', 'https://localhost/*').replaceAll('https://*.uc.cn/*', 'https://localhost/*').replaceAll('https://*.aliyuncs.com/*', 'https://*.localhost/*')
  await writeFile(newtabPath, newtab)
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1500, height: 960 },
    args: ['--enable-unsafe-extension-debugging', '--ignore-certificate-errors'],
  })
  clients.push({ context, profile })
  const session = await context.browser()!.newBrowserCDPSession()
  const { id } = await session.send('Extensions.loadUnpacked', { path: extension })
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/chrome_url_overrides/newtab.html`)
  if (!quarkMode && !existingProfile) await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  return { context, page, profile, url: page.url() }
}

async function connect(page: Page, path = '/dav/', spaceTitle = '我的空间') {
  await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  await page.getByLabel('昵称', { exact: true }).fill('Rain')
  await page.getByLabel('WebDAV 地址').fill(`${origin}${path}`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: '连接并开始' }).click()
  await expect(page.getByRole('heading', { name: spaceTitle, exact: true })).toBeVisible()
}

async function connectQuark(page: Page, spaceTitle = '我的空间') {
  const fromSettings = await page.getByRole('heading', { name: '设置', exact: true }).count() > 0
  await page.getByRole('button', { name: '夸克网盘', exact: true }).click()
  await page.getByRole('button', { name: /扫码登录夸克|重新扫码 \/ 切换账号/ }).click()
  await expect(page.getByLabel('夸克登录二维码')).toBeVisible()
  if (fromSettings) await expect(page.getByText(/当前夸克账号：/)).toBeVisible()
  else await expect(page.getByRole('heading', { name: spaceTitle, exact: true })).toBeVisible()
}

test('夸克首次安装直接显示二维码，不依赖运行时新增权限或重新加载', async () => {
  quark.qrPending = true
  const { page } = await openClient(undefined, true)
  await page.evaluate(() => {
    chrome.permissions.request = async () => { throw new Error('首次扫码不应申请新权限') }
  })
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByLabel('夸克登录二维码')).toBeVisible()
})

test('夸克访问权限未启用时明确提示并恢复登录按钮', async () => {
  const { page } = await openClient(undefined, true)
  await page.evaluate(() => {
    chrome.permissions.contains = async () => false
  })
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('夸克访问权限未启用')
  await expect(page.getByRole('button', { name: '扫码登录夸克', exact: true })).toBeEnabled()
})

test('夸克后台未回复时结束二维码等待并可重试', async () => {
  quark.qrPending = true
  const { page } = await openClient(undefined, true)
  await page.clock.install()
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    let first = true
    chrome.runtime.sendMessage = ((...args: Parameters<typeof send>) => {
      if (first && (args[0] as { type?: string })?.type === 'quark-qr-start') {
        first = false
        return new Promise(() => {})
      }
      return send(...args)
    }) as typeof chrome.runtime.sendMessage
  })
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByRole('button', { name: '正在获取二维码…', exact: true })).toBeVisible()
  await page.clock.runFor(31_000)
  await expect(page.getByRole('alert')).toContainText('二维码请求超时')
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByLabel('夸克登录二维码')).toBeVisible()
})

test('夸克扫码后签名上传并轮换 Cookie，重开和另一设备读取收藏', async () => {
  quark.loginRedirect = true
  quark.qrPending = true
  const first = await openClient(undefined, true)
  await expect(first.page.getByRole('button', { name: '扫码登录夸克', exact: true })).toBeVisible()
  await first.page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(first.page.getByLabel('夸克登录二维码')).toBeVisible()
  await first.page.screenshot({ path: test.info().outputPath('quark-login.png') })
  quark.qrPending = false
  await expect(first.page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
  await addLink(first.page, '夸克里的 React')
  await sync(first.page)
  const snapshots = quark.snapshots()
  expect(snapshots.length).toBeGreaterThan(0)
  expect(snapshots.some(file => file.body.includes('夸克里的 React'))).toBe(true)
  expect(snapshots.every(file => !file.body.includes('__puus') && !file.body.includes('qr_seed'))).toBe(true)
  expect(quark.deleted).toBe(0)
  await first.page.reload()
  await expect(first.page.getByRole('link', { name: '夸克里的 React', exact: true })).toBeVisible()
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await expect(second.page.getByRole('link', { name: '夸克里的 React', exact: true })).toBeVisible()
})

test('夸克上传失败不删除旧版本，离线新增重开保留并能重试', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, '已经保存的收藏')
  await sync(page)
  const previous = quark.snapshots().map(file => file.fid)
  quark.failUpload = true
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(page, '稍后上传的收藏')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('同步未完成')
  for (const fid of previous) expect(quark.files.has(fid)).toBe(true)
  expect(quark.deleted).toBe(0)
  await page.reload()
  await expect(page.getByRole('link', { name: '稍后上传的收藏', exact: true })).toBeVisible()
  quark.failUpload = false
  await sync(page)
  expect(quark.snapshots().some(file => file.body.includes('稍后上传的收藏'))).toBe(true)
})

test('夸克二维码过期可刷新，登录失效时保留本地并支持重新扫码', async () => {
  const { page } = await openClient(undefined, true)
  quark.qrExpired = true
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('二维码已过期')
  quark.qrExpired = false
  await page.getByRole('button', { name: '刷新二维码', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
  await addLink(page, '登录失效仍保留')
  await sync(page)
  quark.expired = true
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('请重新扫码')
  await page.reload()
  await expect(page.getByRole('link', { name: '登录失效仍保留', exact: true })).toBeVisible()
  quark.expired = false
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true }).click()
  await expect(page.getByText('扫码已完成', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true })).toBeVisible()
  await sync(page)
})

test('夸克两设备同时保存形成分支，不同收藏自动合并且旧版本保留', async () => {
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await addLink(first.page, '共同收藏')
  await sync(first.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  quark.parallelUploads = 2
  await Promise.all([addLink(first.page, '设备一收藏'), addLink(second.page, '设备二收藏')])
  await Promise.all([sync(first.page), sync(second.page)])
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '设备二收藏', exact: true })).toBeVisible()
  await sync(second.page)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(second.page.getByRole('link', { name: '设备一收藏', exact: true })).toBeVisible()
  expect(quark.deleted).toBe(0)
})

test('夸克账号切换隔离本地与云端，切回读取自己的收藏', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, 'Rain 的收藏')
  await sync(page)
  quark.nextAccount = 'other'
  await page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true }).click()
  await expect(page.getByText('当前夸克账号：other')).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Rain 的收藏', exact: true })).toHaveCount(0)
  await addLink(page, 'Other 的收藏')
  await sync(page)
  expect(quark.snapshots('other').every(file => !file.body.includes('Rain 的收藏'))).toBe(true)
  quark.nextAccount = 'rain'
  await page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true }).click()
  await expect(page.getByText('当前夸克账号：rain')).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Rain 的收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Other 的收藏', exact: true })).toHaveCount(0)
})

test('夸克并行编辑同一收藏保留两个云端版本，选择后停止反复冲突', async () => {
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await addLink(first.page, '需要合并的收藏')
  await sync(first.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  quark.parallelUploads = 2
  await Promise.all([renameLink(first.page, '需要合并的收藏', '设备一的标题'), renameLink(second.page, '需要合并的收藏', '设备二的标题')])
  await Promise.all([sync(first.page), sync(second.page)])
  await first.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(first.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await expect(first.page.getByText('设备一的标题', { exact: true }).first()).toBeVisible()
  await expect(first.page.getByText('设备二的标题', { exact: true }).first()).toBeVisible()
  await first.page.getByRole('button', { name: '保留本地版本', exact: true }).first().click()
  await expect(first.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toHaveCount(0)
  await sync(first.page)
  await sync(first.page)
  expect(quark.snapshots().some(file => file.body.includes('设备一的标题'))).toBe(true)
  expect(quark.snapshots().some(file => file.body.includes('设备二的标题'))).toBe(true)
  expect(quark.deleted).toBe(0)
})

test('夸克远端损坏时不上传空数据，修正后恢复保存', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, '原始收藏')
  await sync(page)
  const count = quark.snapshots().length
  quark.downloadsCorrupt = true
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('已损坏')
  expect(quark.snapshots()).toHaveLength(count)
  await page.reload()
  await expect(page.getByRole('link', { name: '原始收藏', exact: true })).toBeVisible()
  quark.downloadsCorrupt = false
  await sync(page)
})

test('夸克目录延迟列出已上传版本时不回退本地收藏，列表恢复后正常同步', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await sync(page)
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(page, '目录延迟也不能丢的收藏')
  await sync(page)
  for (const file of quark.snapshots()) if (file.body.includes('目录延迟也不能丢的收藏')) quark.hiddenVersions.add(file.fid)
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('尚未')
  await page.reload()
  await expect(page.getByRole('link', { name: '目录延迟也不能丢的收藏', exact: true })).toBeVisible()
  quark.hiddenVersions.clear()
  await sync(page)
})

test('夸克扫码成功但读取失败时可重试读取，无需重新扫码', async () => {
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await addLink(first.page, '重试后读取的收藏')
  await sync(first.page)
  quark.downloadsCorrupt = true
  const second = await openClient(undefined, true)
  await second.page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(second.page.getByRole('alert')).toContainText('已损坏')
  await expect(second.page.getByRole('button', { name: '重新读取收藏', exact: true })).toBeVisible()
  quark.downloadsCorrupt = false
  await second.page.getByRole('button', { name: '重新读取收藏', exact: true }).click()
  await expect(second.page.getByRole('link', { name: '重试后读取的收藏', exact: true })).toBeVisible()
})

test('已有 WebDAV 收藏可扫码迁移到夸克，保留收藏和待办', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '迁移到夸克的收藏')
  await page.getByRole('article', { name: '链接 迁移到夸克的收藏' }).hover()
  await page.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await sync(page)
  await connectQuark(page)
  await sync(page)
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '迁移到夸克的收藏', exact: true })).toBeVisible()
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await second.page.getByRole('button', { name: /^Todo/ }).click()
  await expect(second.page.getByRole('link', { name: '迁移到夸克的收藏', exact: true })).toBeVisible()
})

async function addLink(page: Page, title: string, url = 'https://react.dev/') {
  const tab = await page.context().newPage()
  await tab.route('**/*', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<title>${title.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</title><h1>Controlled website</h1>` }))
  await tab.goto(url)
  await page.bringToFront()
  await drag(page, page.getByRole('article', { name: `待选 ${title}`, exact: true }), page.getByRole('region', { name: /^收藏块/ }).first())
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible()
  await tab.close()
}

test('首次连接后添加收藏，重开仍保留且同步到另一设备', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, 'React 学习')
  await first.page.reload()
  await expect(first.page.getByRole('link', { name: 'React 学习', exact: true })).toBeVisible()
  await expect(first.page.getByText('已同步', { exact: true }).first()).toBeVisible()
  const second = await openClient()
  await connect(second.page)
  await expect(second.page.getByRole('link', { name: 'React 学习', exact: true })).toBeVisible()
})

test('重复网址卡片的 Todo 独立，完成后原收藏保留并可再次加入', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '学习 React')
  await addLink(page, '工作中参考')
  const firstCard = page.getByRole('article').filter({ has: page.getByRole('link', { name: '学习 React', exact: true }) })
  await firstCard.hover()
  await firstCard.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '学习 React', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '工作中参考', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '完成待办', exact: true }).click()
  await expect(page.getByRole('link', { name: '学习 React', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: '学习 React', exact: true })).toBeVisible()
  await firstCard.hover()
  await firstCard.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '学习 React', exact: true })).toBeVisible()
})

test('创建空间与收藏块，编辑自动保存，并从全空间搜索定位', async () => {
  const { page } = await openClient()
  await connect(page)
  await page.getByRole('button', { name: '新建空间', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('工作')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: '工作', exact: true }).click()
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('开发参考')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await addLink(page, 'React 参考')
  const card = page.getByRole('article').filter({ has: page.getByRole('link', { name: 'React 参考', exact: true }) })
  await card.hover()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('备注', { exact: true }).fill('并发渲染的备忘')
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /搜索收藏/ }).click()
  await expect(page.getByRole('dialog', { name: '搜索收藏', exact: true })).toBeVisible()
  await page.getByRole('searchbox', { name: '搜索全部收藏' }).fill('并发渲染')
  await expect(page.getByRole('link', { name: 'React 参考', exact: true })).toBeVisible()
  const result = page.getByRole('dialog', { name: '搜索收藏', exact: true }).getByRole('article')
  await result.getByRole('button', { name: '编辑链接', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '编辑链接', exact: true })).toBeVisible()
  await page.getByRole('dialog', { name: '编辑链接', exact: true }).getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '搜索收藏', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/search-dialog.png', fullPage: true })
  await page.getByRole('button', { name: '定位收藏', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '搜索收藏', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '工作', exact: true })).toBeVisible()
  await expect(page.getByText('并发渲染的备忘', { exact: true })).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.getByRole('dialog', { name: '搜索收藏', exact: true }).getByRole('searchbox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '工作', exact: true })).toBeVisible()
})

async function drag(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded()
  const from = (await source.boundingBox())!
  await target.scrollIntoViewIfNeeded()
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + Math.min(from.width / 2, 80), from.y + Math.min(from.height / 2, 36))
  await page.mouse.down()
  await page.mouse.move(from.x + 14, from.y + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 })
  await page.mouse.up()
  await expect(page.locator('.drag-preview')).toHaveCount(0)
}

test('收藏卡片移除旧移动图标，空备注不保留多余底部高度', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '紧凑收藏')
  const card = page.getByRole('article', { name: '链接 紧凑收藏', exact: true })
  await card.hover()
  await expect(card.getByRole('button', { name: '移动链接', exact: true })).toHaveCount(0)
  expect((await card.boundingBox())!.height).toBeLessThan(145)
})

test('拖动保留完整卡片和原尺寸，落点显示等尺寸占位', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '保留内容的卡片')
  const card = page.getByRole('article', { name: '链接 保留内容的卡片', exact: true })
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('备注', { exact: true }).fill('拖动时这段备注也完整保留')
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await addLink(page, '目标卡片')
  const source = (await card.boundingBox())!
  const target = (await page.getByRole('article', { name: '链接 目标卡片', exact: true }).boundingBox())!
  await page.mouse.move(source.x + 65, source.y + 35)
  await page.mouse.down()
  await page.mouse.move(target.x + target.width / 2, target.y + 35, { steps: 20 })
  const preview = page.locator('.drag-preview')
  await expect(preview.getByText('拖动时这段备注也完整保留', { exact: true })).toBeVisible()
  await expect(preview.getByText('react.dev', { exact: true })).toBeVisible()
  const floating = (await preview.boundingBox())!
  expect(Math.abs(floating.width - source.width)).toBeLessThan(2)
  expect(Math.abs(floating.height - source.height)).toBeLessThan(2)
  await expect(card.getByText('拖动时这段备注也完整保留', { exact: true })).not.toBeVisible()
  await expect.poll(async () => Math.abs((await card.boundingBox())!.x - target.x)).toBeLessThan(3)
  await page.screenshot({ path: 'test-results/card-drag-placeholder.png', fullPage: true })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '收藏块 日常收藏' }).getByRole('link')).toHaveText(['目标卡片', '保留内容的卡片'])
})

test('待选网页拖入先显示落点，占位与预览平滑过渡为收藏卡片', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const inbox = page.getByRole('article', { name: '待选 React 文档', exact: true })
  const from = (await inbox.boundingBox())!
  const collection = page.getByRole('region', { name: '收藏块 日常收藏' })
  const target = (await collection.boundingBox())!
  await page.mouse.move(from.x + 70, from.y + 25)
  await page.mouse.down()
  await page.mouse.move(target.x + 100, target.y + 95, { steps: 20 })
  const preview = page.locator('.drag-preview')
  await expect(page.getByRole('img', { name: '收藏放置位置' })).toBeVisible()
  expect(Math.abs((await preview.boundingBox())!.height - from.height)).toBeLessThan(2)
  await page.screenshot({ path: 'test-results/inbox-drop-placeholder.png', fullPage: true })
  const frames = page.evaluate(async () => {
    const heights: { floating: number; saved: number }[] = []
    const start = performance.now()
    while (performance.now() - start < 1200) {
      const floating = document.querySelector('.drag-preview')?.getBoundingClientRect()
      const saved = document.querySelector('article[aria-label="链接 React 文档"]')?.getBoundingClientRect()
      if (floating && saved) heights.push({ floating: floating.height, saved: saved.height })
      await new Promise(requestAnimationFrame)
    }
    return heights
  })
  await page.mouse.up()
  const card = page.getByRole('article', { name: '链接 React 文档', exact: true })
  expect((await frames).some(frame => frame.floating > from.height + 3 && frame.floating < frame.saved - 3)).toBe(true)
  await expect(preview).toHaveCount(0)
  await expect(card).toBeVisible()
  await expect(collection.getByRole('link')).toHaveCount(1)
  expect(tab.isClosed()).toBe(false)
})

test('跨收藏块的落点占位稳定，折叠块取消拖动后保持原状', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '跨块移动项')
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('来源块')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  const destination = page.getByRole('region', { name: '收藏块 日常收藏' })
  const sourceBlock = page.getByRole('region', { name: '收藏块 来源块' })
  await drag(page, destination.getByRole('article'), sourceBlock)
  await addLink(page, '目标首项')
  const sourceCard = sourceBlock.getByRole('article')
  const from = (await sourceCard.boundingBox())!
  const target = (await destination.getByRole('article').boundingBox())!
  await page.mouse.move(from.x + 60, from.y + 30)
  await page.mouse.down()
  await page.mouse.move(target.x + 60, target.y + 30, { steps: 20 })
  const marker = page.getByRole('img', { name: '收藏放置位置' })
  await expect(marker).toBeVisible()
  const positions = await page.evaluate(async () => {
    const xs: number[] = []
    const start = performance.now()
    while (performance.now() - start < 400) {
      xs.push(document.querySelector('[aria-label="收藏放置位置"]')!.getBoundingClientRect().x)
      await new Promise(requestAnimationFrame)
    }
    return xs
  })
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(3)
  expect(Math.abs((await marker.boundingBox())!.x - target.x)).toBeLessThan(3)
  await page.mouse.up()
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  await expect(destination.getByRole('article')).toHaveCount(2)
  await expect(sourceBlock.getByRole('article')).toHaveCount(0)
  await sourceBlock.getByRole('button', { name: '折叠 来源块', exact: true }).click()
  const moving = (await destination.getByRole('article').first().boundingBox())!
  const collapsed = (await sourceBlock.boundingBox())!
  await page.mouse.move(moving.x + 60, moving.y + 30)
  await page.mouse.down()
  await page.mouse.move(collapsed.x + 120, collapsed.y + 25, { steps: 20 })
  await expect(marker).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  await expect(marker).toHaveCount(0)
  await expect(sourceBlock.getByRole('button', { name: '展开 来源块', exact: true })).toBeVisible()
  await expect(destination.getByRole('article')).toHaveCount(2)
})

test('Todo 使用独立清单排序，标题可打开，新加入和重新加入置末尾，重开与夸克同步保留', async () => {
  test.setTimeout(90_000)
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  const page = first.page
  for (const title of ['先处理', '后处理']) {
    await addLink(page, title)
    const card = page.getByRole('article', { name: `链接 ${title}`, exact: true })
    await card.hover()
    await card.getByRole('button', { name: '加入 Todo', exact: true }).click()
  }
  await page.getByRole('button', { name: '新建空间', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('另一个空间')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: '另一个空间', exact: true }).click()
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('参考')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await addLink(page, '跨空间待办')
  await page.getByRole('article', { name: '链接 跨空间待办', exact: true }).getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  const list = page.getByRole('list', { name: '待办清单' })
  await expect(list.getByRole('link')).toHaveText(['先处理', '后处理', '跨空间待办'])
  await expect(list.getByRole('button', { name: /编辑|删除|移动|定位/ })).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: '待选网页' })).toBeVisible()
  await page.screenshot({ path: 'test-results/todo-desktop.png', fullPage: true })
  await drag(page, list.getByRole('listitem').last(), list.getByRole('listitem').first())
  await expect(list.getByRole('link')).toHaveText(['跨空间待办', '先处理', '后处理'])
  const opened = page.context().waitForEvent('page')
  await list.getByRole('link', { name: '先处理', exact: true }).focus()
  await page.keyboard.press('Enter')
  const openedPage = await opened
  await expect(openedPage).toHaveURL('https://react.dev/')
  await openedPage.close()
  await list.getByRole('listitem').filter({ has: page.getByRole('link', { name: '先处理', exact: true }) }).getByRole('button', { name: '完成待办', exact: true }).click()
  await expect(list.getByRole('link')).toHaveText(['跨空间待办', '后处理'])
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('region', { name: '收藏块 日常收藏' }).getByRole('link')).toHaveText(['先处理', '后处理'])
  await page.getByRole('article', { name: '链接 先处理', exact: true }).getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(list.getByRole('link')).toHaveText(['跨空间待办', '后处理', '先处理'])
  await sync(page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await second.page.getByRole('button', { name: /^Todo/ }).click()
  await expect(second.page.getByRole('list', { name: '待办清单' }).getByRole('link')).toHaveText(['跨空间待办', '后处理', '先处理'])
  await second.context.setOffline(true)
  const secondList = second.page.getByRole('list', { name: '待办清单' })
  await drag(second.page, secondList.getByRole('listitem').last(), secondList.getByRole('listitem').first())
  await expect(secondList.getByRole('link')).toHaveText(['先处理', '跨空间待办', '后处理'])
  await second.context.close()
  clients.splice(clients.findIndex(client => client.context === second.context), 1)
  quark.unavailable = true
  const restarted = await openClient(second.profile, true)
  await restarted.page.getByRole('button', { name: /^Todo/ }).click()
  await expect(restarted.page.getByRole('list', { name: '待办清单' }).getByRole('link')).toHaveText(['先处理', '跨空间待办', '后处理'])
  quark.unavailable = false
  await sync(restarted.page)
  await sync(page)
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(list.getByRole('link')).toHaveText(['先处理', '跨空间待办', '后处理'])
})

test('日常收藏只能从待选网页拖入，无手动和批量入口，空备注留空', async () => {
  const { page, context } = await openClient()
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const guide = await context.newPage()
  await guide.goto(`${origin}/web/guide`)
  await connect(page)
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(page.getByRole('button', { name: /添加链接|添加第一个链接|收藏当前窗口/ })).toHaveCount(0)
  await expect(inbox.getByText('React 文档', { exact: true })).toBeVisible()
  await drag(page, inbox.getByRole('article', { name: '待选 React 文档' }), page.getByRole('region', { name: '收藏块 日常收藏' }))
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('还没有备注', { exact: true })).toHaveCount(0)
  await expect(page.getByText('改动自动保存', { exact: true })).toHaveCount(0)
  await expect(page.getByText('一点点收集，一点点生长', { exact: true })).toHaveCount(0)
  expect(tab.isClosed()).toBe(false)
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('稍后阅读')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: '折叠 稍后阅读', exact: true }).click()
  await drag(page, page.getByRole('article', { name: '链接 React 文档', exact: true }), page.getByRole('region', { name: '收藏块 稍后阅读' }))
  await expect(page.getByRole('region', { name: '收藏块 稍后阅读' }).getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await drag(page, inbox.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), page.getByRole('region', { name: '收藏块 日常收藏' }))
  await expect(page.getByRole('link', { name: 'UnoCSS 指南', exact: true })).toBeVisible()
  expect(guide.isClosed()).toBe(false)
  await page.setViewportSize({ width: 820, height: 900 })
  await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
  await expect(inbox.getByText('UnoCSS 指南', { exact: true })).toBeVisible()
  await guide.close()
  await expect(inbox.getByText('UnoCSS 指南', { exact: true })).toHaveCount(0)
})

test('删除收藏块隐藏 Todo，回收站恢复层次与标记，备份不含凭据', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '值得重读')
  await page.getByRole('article').hover()
  await page.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.getByRole('button', { name: '删除 日常收藏', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '值得重读', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('显示昵称').fill('小雨')
  await page.getByRole('button', { name: '恢复 日常收藏', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '值得重读', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份', exact: true }).click()
  const download = await downloadPromise
  const backup = await readFile((await download.path())!, 'utf8')
  expect(backup).toContain('值得重读')
  expect(backup).not.toContain('secret')
  expect(backup).not.toContain('password')
  await page.getByLabel('导入备份').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{"version":999}') })
  await expect(page.getByRole('alert')).toContainText('格式')
  await page.reload()
  await expect(page.getByText('小雨', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '值得重读', exact: true })).toBeVisible()
})

async function sync(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  await expect(page.getByText('已同步', { exact: true }).first()).toBeVisible()
}
async function renameLink(page: Page, title: string, next: string) {
  const card = page.getByRole('article', { name: `链接 ${title}`, exact: true })
  await card.hover()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('标题', { exact: true }).fill(next)
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(page.getByRole('link', { name: next, exact: true })).toBeVisible()
}

test('离线编辑重开保留，不同条目合并；同条目冲突保留两份并选择', async () => {
  test.setTimeout(90_000)
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '条目 A')
  await addLink(first.page, '条目 B')
  await sync(first.page)
  const second = await openClient()
  await connect(second.page)
  await expect(second.page.getByRole('link', { name: '条目 A', exact: true })).toBeVisible()
  unavailable = true
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await renameLink(first.page, '条目 A', '离线编辑 A')
  await renameLink(second.page, '条目 B', '另一设备 B')
  await first.page.reload()
  await expect(first.page.getByRole('link', { name: '离线编辑 A', exact: true })).toBeVisible()
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  unavailable = false
  await sync(first.page)
  await sync(second.page)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(second.page.getByRole('link', { name: '离线编辑 A', exact: true })).toBeVisible()
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '另一设备 B', exact: true })).toBeVisible()
  unavailable = true
  await renameLink(first.page, '离线编辑 A', '本机的新标题')
  await renameLink(second.page, '离线编辑 A', '远端的新标题')
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  unavailable = false
  await sync(first.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await expect(second.page.getByText('远端的新标题', { exact: true })).toHaveCount(2)
  await expect(second.page.getByText('本机的新标题', { exact: true })).toBeVisible()
  await second.page.getByRole('button', { name: '保留本地版本', exact: true }).click()
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toHaveCount(0)
  await sync(second.page)
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '远端的新标题', exact: true })).toBeVisible()
  await expect(first.page.getByRole('link', { name: '另一设备 B', exact: true })).toBeVisible()
})

async function changeSource(page: Page, path: string, mode: 'switch' | 'migrate' = 'switch') {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('WebDAV 地址').fill(`${origin}${path}`)
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('radio', { name: mode === 'switch' ? /切换到另一份数据/ : /迁移当前数据/ }).check()
  await page.getByRole('button', { name: '连接数据源', exact: true }).click()
  await expect(page.getByRole('button', { name: '连接数据源', exact: true })).toBeEnabled()
}

test('切换隔离数据源，迁移到空目标直接保留内容和昵称', async () => {
  const { page } = await openClient()
  await connect(page, '/source-a/')
  await addLink(page, '源 A 的收藏')
  await sync(page)
  await changeSource(page, '/source-b/')
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: '源 A 的收藏', exact: true })).toHaveCount(0)
  await addLink(page, '源 B 的收藏')
  await sync(page)
  await changeSource(page, '/source-a/')
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: '源 A 的收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '源 B 的收藏', exact: true })).toHaveCount(0)
  await changeSource(page, '/source-c/', 'migrate')
  await expect(page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toHaveCount(0)
  await expect(page.getByText('Rain', { exact: true })).toBeVisible()
  await sync(page)
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: '源 A 的收藏', exact: true })).toBeVisible()
  const other = await openClient()
  await connect(other.page, '/source-c/')
  await expect(other.page.getByRole('link', { name: '源 A 的收藏', exact: true })).toBeVisible()
})


test('父级删除与离线编辑冲突，其他收藏仍可编辑，保留编辑版恢复有效层次', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '父级里的链接')
  await sync(first.page)
  const second = await openClient()
  await connect(second.page)
  unavailable = true
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await first.page.getByRole('button', { name: '删除 日常收藏', exact: true }).click()
  await first.page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await renameLink(second.page, '父级里的链接', '离线补充后的链接')
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  unavailable = false
  await sync(first.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await second.page.getByLabel('显示昵称').fill('冲突期间仍可编辑')
  await expect(second.page.getByRole('alert')).toHaveCount(0)
  await second.page.getByRole('button', { name: '保留本地版本', exact: true }).click()
  await sync(second.page)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(second.page.getByRole('region', { name: '收藏块 日常收藏' }).getByRole('link', { name: '离线补充后的链接', exact: true })).toBeVisible()
  await second.page.reload()
  await expect(second.page.getByText('冲突期间仍可编辑', { exact: true })).toBeVisible()
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '离线补充后的链接', exact: true })).toBeVisible()
})

test('拖拽排序空间、收藏块和卡片，跨空间拒绝且至少保留一个空间', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '排在后面')
  await addLink(page, '排在前面')
  await drag(page, page.getByRole('article', { name: '链接 排在前面', exact: true }), page.getByRole('article', { name: '链接 排在后面', exact: true }))
  await expect(page.getByRole('region', { name: '收藏块 日常收藏' }).getByRole('link').first()).toHaveText('排在前面')
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('优先阅读')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await drag(page, page.getByRole('region', { name: '收藏块 优先阅读', exact: true }).getByRole('heading', { level: 2 }), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('heading', { level: 2 }))
  await expect(page.getByRole('region', { name: /^收藏块/ }).first()).toHaveAccessibleName('收藏块 优先阅读')
  await page.getByRole('button', { name: '新建空间', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('灵感')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await drag(page, page.getByRole('button', { name: '灵感', exact: true }), page.getByRole('button', { name: '我的空间', exact: true }))
  await page.reload()
  await expect(page.getByRole('heading', { name: '灵感', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await drag(page, page.getByRole('article', { name: '链接 排在前面', exact: true }), page.getByRole('button', { name: '灵感', exact: true }))
  await expect(page.getByRole('alert')).toContainText('跨空间')
  await expect(page.getByRole('link', { name: '排在前面', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '删除空间 灵感', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await page.getByRole('button', { name: '删除空间 我的空间', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('至少保留一个空间')
})


test('浏览器离线重启仍保留工作副本，条件写入失败会自动重试', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '最初的收藏')
  await sync(first.page)
  unavailable = true
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(first.page, '离线新增')
  await first.context.close()
  clients.splice(clients.findIndex(client => client.profile === first.profile), 1)
  const restarted = await openClient(first.profile)
  await expect(restarted.page.getByRole('link', { name: '离线新增', exact: true })).toBeVisible()
  await expect(restarted.page.getByRole('link', { name: '最初的收藏', exact: true })).toBeVisible()
  unavailable = false
  rejectNextWrite = true
  await sync(restarted.page)
  const other = await openClient()
  await connect(other.page)
  await expect(other.page.getByRole('link', { name: '离线新增', exact: true })).toBeVisible()
  await expect(other.page.getByRole('link', { name: '离线新增', exact: true })).toHaveCount(1)
})

test('认证失败与不安全 WebDAV 明确报错，修正后可以连接', async () => {
  const { page } = await openClient()
  await page.getByLabel('昵称', { exact: true }).fill('Rain')
  await page.getByLabel('WebDAV 地址').fill(`${origin}/dav/`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('wrong-password')
  await page.getByRole('button', { name: '连接并开始', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('认证或权限失败')
  unsafeWrites = true
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: '连接并开始', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('条件写入')
  expect(files.has('/dav/new-page/data-v1.json')).toBe(false)
  unsafeWrites = false
  await page.getByRole('button', { name: '连接并开始', exact: true }).click()
  await expect(page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
})

for (const missing of ['GET', 'PUT'] as const) {
  test(`WebDAV ${missing} 缺少 ETag 时在连接阶段拒绝，清理探测文件且不上传收藏`, async () => {
    omitGetTag = missing === 'GET'
    omitPutTag = missing === 'PUT'
    const { page } = await openClient()
    await page.getByLabel('昵称', { exact: true }).fill('Rain')
    await page.getByLabel('WebDAV 地址').fill(`${origin}/dav/`)
    await page.getByLabel('用户名', { exact: true }).fill('tester')
    await page.getByLabel('密码或应用专用密码').fill('secret')
    await page.getByRole('button', { name: '连接并开始', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText(`${missing} 响应未提供强 ETag`)
    expect(files.size).toBe(0)
    await page.reload()
    await expect(page.getByRole('button', { name: '扫码登录夸克', exact: true })).toBeVisible()
    omitGetTag = false
    omitPutTag = false
    await connect(page)
  })
}

test('回收站超过三十天清理正文，旧设备刷新不会复活删除收藏', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '会过期的收藏')
  await sync(first.page)
  const oldDevice = await openClient()
  await connect(oldDevice.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await first.page.getByRole('article', { name: '链接 会过期的收藏' }).hover()
  await first.page.getByRole('button', { name: '删除链接', exact: true }).click()
  await first.page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await sync(first.page)
  await expect(first.page.getByRole('button', { name: '恢复 会过期的收藏', exact: true })).toBeVisible()
  // Advance the deletion time through the controlled WebDAV boundary, not private extension state.
  const path = '/dav/new-page/data-v1.json'
  const remote = files.get(path)!
  const backup = JSON.parse(remote.body)
  for (const entity of Object.values(backup.entities) as { deletedAt: number | null; updatedAt: number }[]) {
    if (entity.deletedAt !== null) { entity.deletedAt = Date.now() - 31 * 86400_000; entity.updatedAt = entity.deletedAt }
  }
  files.set(path, { body: JSON.stringify(backup), revision: remote.revision + 1 })
  await sync(first.page)
  await expect(first.page.getByRole('button', { name: '恢复 会过期的收藏', exact: true })).toHaveCount(0)
  await sync(oldDevice.page)
  await oldDevice.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(oldDevice.page.getByRole('link', { name: '会过期的收藏', exact: true })).toHaveCount(0)
  const newDevice = await openClient()
  await connect(newDevice.page)
  await expect(newDevice.page.getByRole('link', { name: '会过期的收藏', exact: true })).toHaveCount(0)
})

test('非空目标迁移先确认合并，合法备份导入保留已有收藏', async () => {
  const { page } = await openClient()
  await connect(page, '/one/')
  await addLink(page, '来源一的收藏')
  await sync(page)
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份', exact: true }).click()
  const backup = await readFile((await (await downloaded).path())!)
  await changeSource(page, '/two/')
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(page, '来源二的收藏')
  await sync(page)
  await changeSource(page, '/one/')
  await page.getByRole('radio', { name: /迁移当前数据/ }).check()
  await page.getByLabel('WebDAV 地址').fill(`${origin}/two/`)
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: '连接数据源', exact: true }).click()
  await expect(page.getByText(/目标已有收藏/)).toBeVisible()
  await page.getByRole('button', { name: '确认合并', exact: true }).click()
  await expect(page.getByRole('button', { name: '保留本地版本', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '保留本地版本', exact: true }).click()
  await page.getByLabel('导入备份').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup })
  await expect(page.getByRole('dialog', { name: '合并备份', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '确认导入', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await page.getByRole('searchbox').fill('来源')
  await expect(page.getByRole('link', { name: '来源一的收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '来源二的收藏', exact: true })).toBeVisible()
})

test('桌面与窄窗口布局保持主要入口，编辑无效网址保留原收藏', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const guide = await context.newPage()
  await guide.goto(`${origin}/web/guide`)
  await addLink(page, 'React · 构建交互界面')
  await addLink(page, 'TypeScript 使用手册', 'https://www.typescriptlang.org/docs/')
  await addLink(page, 'UnoCSS 原子化样式', 'https://unocss.dev/')
  const card = page.getByRole('article', { name: '链接 React · 构建交互界面', exact: true })
  await card.hover()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('备注', { exact: true }).fill('从组件开始，把灵感做成可以使用的东西。')
  await page.getByRole('dialog').getByLabel('网址', { exact: true }).fill('chrome://settings')
  await expect(page.getByRole('dialog')).toContainText('HTTP 或 HTTPS')
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(page.getByRole('link', { name: 'React · 构建交互界面', exact: true })).toHaveAttribute('href', 'https://react.dev/')
  await card.hover()
  await card.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('设计与灵感')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  const collection = page.getByRole('region', { name: '收藏块 设计与灵感' })
  await drag(page, page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), collection)
  await page.screenshot({ path: 'test-results/workbench-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 820, height: 900 })
  await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '待选网页' })).toBeVisible()
  await page.screenshot({ path: 'test-results/workbench-narrow.png', fullPage: true })
  await page.setViewportSize({ width: 480, height: 900 })
  await page.getByRole('button', { name: '关闭待选网页', exact: true }).click()
  await expect(page.getByRole('button', { name: '新建空间', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible()
  await page.keyboard.press('/')
  await expect(page.getByRole('searchbox', { name: '搜索全部收藏', exact: true })).toBeFocused()
})

test('浅色流体背景响应鼠标，仍可打开弹窗和正常收藏', async () => {
  const { page } = await openClient()
  await connect(page)
  const clip = { x: 245, y: 5, width: 400, height: 90 }
  await page.mouse.move(100, 900)
  const before = await page.screenshot({ clip })
  await page.mouse.move(260, 35)
  await page.mouse.move(620, 65, { steps: 25 })
  await expect.poll(async () => (await page.screenshot({ clip })).equals(before), { timeout: 5000 }).toBe(false)
  await page.screenshot({ path: 'test-results/fluid-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await addLink(page, '流体背景上的收藏')
})

test('流体初始化不可用时仍能收藏、编辑和处理 Todo', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '无 GPU 时的收藏')
  await page.addInitScript(`const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) {
      return kind === 'webgl' || kind === 'webgl2' ? null : original.call(this, kind, ...args);
    };`)
  await page.reload()
  const card = page.getByRole('article', { name: '链接 无 GPU 时的收藏', exact: true })
  await card.hover()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('备注', { exact: true }).fill('备注仍可保存')
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(card.getByText('备注仍可保存', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('备注', { exact: true }).fill('')
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(card.getByText('备注仍可保存', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/还没有备注|无备注|有效改动自动保存/)).toHaveCount(0)
  await addLink(page, '仍可拖入')
  await card.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await page.getByRole('button', { name: '完成待办', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect(page.getByRole('link', { name: '无 GPU 时的收藏', exact: true })).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

for (const provider of ['夸克', 'WebDAV'] as const) test(`${provider} 旧版待办可读取，排序与备份恢复保留，拖入 Todo 不产生操作`, async () => {
  const legacy = JSON.parse(await readFile(resolve('tests/fixtures/legacy-snapshot.json'), 'utf8'))
  if (provider === '夸克') {
    quark.files.set('folder-rain', { fid: 'folder-rain', parent: '0', name: '拾页收藏', directory: true, body: '', account: 'rain' })
    quark.files.set('legacy', { fid: 'legacy', parent: 'folder-rain', name: `pg1-${legacy.id}-root.json`, directory: false, body: JSON.stringify(legacy), account: 'rain' })
  } else files.set('/dav/new-page/data-v1.json', { body: JSON.stringify(legacy.document), revision: 1 })
  const { page, context } = await openClient(undefined, provider === '夸克')
  if (provider === '夸克') await connectQuark(page, '历史空间')
  else await connect(page, '/dav/', '历史空间')
  await page.getByRole('button', { name: /^Todo/ }).click()
  const list = page.getByRole('list', { name: '待办清单' })
  await expect(list.getByRole('link')).toHaveText(['历史待办 A', '历史待办 B', '历史待办 C'])
  await drag(page, list.getByRole('listitem').last(), list.getByRole('listitem').nth(1))
  await expect(list.getByRole('link')).toHaveText(['历史待办 A', '历史待办 C', '历史待办 B'])
  await drag(page, list.getByRole('listitem').last(), list.getByRole('listitem').first())
  await expect(list.getByRole('link')).toHaveText(['历史待办 B', '历史待办 A', '历史待办 C'])
  await list.getByRole('listitem').first().focus()
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  const firstY = (await page.locator('.drag-preview').boundingBox())!.y
  await page.keyboard.press('ArrowDown')
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())!.y).toBeGreaterThan(firstY)
  await page.keyboard.press('Space', { delay: 100 })
  await expect(list.getByRole('link')).toHaveText(['历史待办 A', '历史待办 B', '历史待办 C'])
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  await list.getByRole('listitem').last().focus()
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  const lastY = (await page.locator('.drag-preview').boundingBox())!.y
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())!.y).toBeLessThan(lastY)
  await page.keyboard.press('Space', { delay: 100 })
  await expect(list.getByRole('link')).toHaveText(['历史待办 A', '历史待办 C', '历史待办 B'])
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const originalUrl = page.url()
  const pageCount = context.pages().length
  await drag(page, page.getByRole('article', { name: '待选 React 文档', exact: true }), list.getByRole('listitem').first())
  expect(page.url()).toBe(originalUrl)
  expect(context.pages()).toHaveLength(pageCount)
  await expect(list.getByRole('link')).toHaveText(['历史待办 A', '历史待办 C', '历史待办 B'])
  await page.reload()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(list.getByRole('link')).toHaveText(['历史待办 A', '历史待办 C', '历史待办 B'])
  await sync(page)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份', exact: true }).click()
  const backup = await readFile((await (await downloadPromise).path())!, 'utf8')
  const restored = await openClient()
  await connect(restored.page, '/restored/')
  await restored.page.getByRole('button', { name: '设置', exact: true }).click()
  await restored.page.getByLabel('导入备份').setInputFiles({ name: 'restored.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
  await restored.page.getByRole('button', { name: /^Todo/ }).click()
  await expect(restored.page.getByRole('list', { name: '待办清单' }).getByRole('link')).toHaveText(['历史待办 A', '历史待办 C', '历史待办 B'])
})

test('目标缓存有冲突时拒绝迁移，切回后两个版本仍可选择', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '原始标题')
  await sync(first.page)
  const second = await openClient()
  await connect(second.page)
  unavailable = true
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await renameLink(first.page, '原始标题', '远端保留版本')
  await renameLink(second.page, '原始标题', '本地保留版本')
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  unavailable = false
  await sync(first.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await changeSource(second.page, '/another/')
  await changeSource(second.page, '/dav/', 'migrate')
  await expect(second.page.getByRole('alert')).toContainText('目标数据源有未解决冲突')
  await changeSource(second.page, '/dav/')
  await expect(second.page.getByText('远端保留版本', { exact: true })).toBeVisible()
  await expect(second.page.getByText('本地保留版本', { exact: true })).toHaveCount(2)
  await second.page.getByRole('button', { name: '保留远端版本', exact: true }).click()
  await sync(second.page)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(second.page.getByRole('link', { name: '远端保留版本', exact: true })).toBeVisible()
})

for (const side of ['本地', '远端']) test(`并发删除不同空间仍保留一个可用空间，再选择${side}版本解决冲突`, async () => {
  const first = await openClient()
  await connect(first.page)
  await first.page.getByRole('button', { name: '新建空间', exact: true }).click()
  await first.page.getByRole('dialog').getByLabel('名称').fill('另一空间')
  await first.page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await sync(first.page)
  const second = await openClient()
  await connect(second.page)
  unavailable = true
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await first.page.getByRole('button', { name: '删除空间 我的空间', exact: true }).click()
  await first.page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await second.page.getByRole('button', { name: '删除空间 另一空间', exact: true }).click()
  await second.page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  unavailable = false
  await sync(first.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await expect(second.page.getByRole('navigation', { name: '空间', exact: true }).getByRole('button', { name: '我的空间', exact: true })).toBeVisible()
  await second.page.getByRole('button', { name: `保留${side}版本`, exact: true }).click()
  await sync(second.page)
  const retained = side === '本地' ? '我的空间' : '另一空间'
  await second.page.getByRole('button', { name: retained, exact: true }).click()
  await expect(second.page.getByRole('heading', { name: retained, exact: true })).toBeVisible()
})

test('切回冲突数据源时用最新远端刷新冲突，双方已一致则自动消解', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '共同起点')
  await sync(first.page)
  const second = await openClient()
  await connect(second.page)
  unavailable = true
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await renameLink(first.page, '共同起点', '过时的远端标题')
  await renameLink(second.page, '共同起点', '双方最终采用的标题')
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  unavailable = false
  await sync(first.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await changeSource(second.page, '/away/')
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await renameLink(first.page, '过时的远端标题', '双方最终采用的标题')
  await sync(first.page)
  await changeSource(second.page, '/dav/')
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toHaveCount(0)
  await sync(second.page)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(second.page.getByRole('link', { name: '双方最终采用的标题', exact: true })).toBeVisible()
})


test('迁移时首次发现目标缓存冲突也拒绝覆盖，切换目标仍保留两版', async () => {
  const first = await openClient()
  await connect(first.page)
  await addLink(first.page, '目标条目')
  await sync(first.page)
  const second = await openClient()
  await connect(second.page)
  suspendDataWrites = true
  await renameLink(second.page, '目标条目', '目标尚未上传版本')
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  await changeSource(second.page, '/away/')
  suspendDataWrites = false
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await renameLink(first.page, '目标条目', '目标远端修改版本')
  await sync(first.page)
  await changeSource(second.page, '/dav/', 'migrate')
  await expect(second.page.getByRole('alert')).toContainText('目标数据源有未解决冲突')
  await changeSource(second.page, '/dav/')
  await expect(second.page.getByText('目标远端修改版本', { exact: true })).toBeVisible()
  await expect(second.page.getByText('目标尚未上传版本', { exact: true })).toHaveCount(2)
})
