import { test, expect, chromium, type BrowserContext, type Page, type Locator } from '@playwright/test'
import { createServer, type Server } from 'node:https'
import { mkdtemp, mkdir, rm, rmdir, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getTestCertificate } from './test-cert'
import { QuarkFixture } from './quark-fixture'
import type { StoredWorkspace } from '../src/core/local-workspace'
import type { Document } from '../src/core/model'

type DeferredSnapshotWindow = Window & { releaseSnapshots(): void; pendingSnapshots(): number }

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
const imageHistory: { url: string; hash: string }[] = []
const imageDeletes: string[] = []

test.beforeAll(async () => {
  const cert = await getTestCertificate()
  server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
    if (await quark.handle(req, res, origin)) return
    const path = new URL(req.url!, 'https://localhost').pathname
    if (path.startsWith('/api/v1/file/delete/')) {
      if (req.headers.authorization !== 'Bearer see-cleanup-test') { res.writeHead(401).end(); return }
      imageDeletes.push(decodeURIComponent(path.slice('/api/v1/file/delete/'.length)))
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, code: '200' })); return
    }
    if (path === '/api/v1/files') {
      if (req.headers.authorization !== 'Bearer see-cleanup-test') { res.writeHead(401).end(); return }
      const page = new URL(req.url!, 'https://localhost').searchParams.get('page')
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code: 200, data: page === '1' ? imageHistory : [] })); return
    }
    if (path.startsWith('/markdown/')) {
      if (path.endsWith('redirect.md')) { res.writeHead(302, { Location: '/markdown/html.md' }).end(); return }
      if (path.endsWith('sniffed.md')) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end('<!DOCTYPE html><html><title>实际网页</title><h1>原始网页</h1></html>'); return }
      if (path.endsWith('html.md')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<title>实际网页</title><h1>原始网页</h1>'); return }
      if (path.endsWith('error.md')) { res.writeHead(503).end(); return }
      res.setHeader('Content-Type', path.endsWith('plain.md') ? 'text/plain; charset=utf-8' : path.endsWith('legacy.md') ? 'Text/X-Markdown; charset=utf-8' : 'text/markdown; charset=utf-8')
      res.end(path.endsWith('next.md') ? '# 下一篇\n\n关联文件正文' : '# 阅读指南\n\n## 安装步骤\n\n在线正文\n\n[下一篇](./next.md)\n\n![示意图](./figure.svg)\n\n| 列名 | 值 |\n| --- | --- |\n| 内容 | 通过 |\n\n- [x] 已检查\n\n```js\nconst ready = true\n```')
      return
    }
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

test.beforeEach(() => { files.clear(); quark.reset(); imageHistory.length = 0; imageDeletes.length = 0; unavailable = false; unsafeWrites = false; omitGetTag = false; omitPutTag = false; rejectNextWrite = false; suspendDataWrites = false })
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
  manifest.host_permissions = ['https://localhost/*', 'https://*.localhost/*', 'file:///*']
  await writeFile(manifestPath, JSON.stringify(manifest))
  // Redirect only the isolated test copy's API origins. Production keeps Quark.
  const backgroundPath = join(extension, 'background/service_worker.js')
  let background = await readFile(backgroundPath, 'utf8')
  for (const host of ['https://drive-pc.quark.cn', 'https://uop.quark.cn', 'https://pan.quark.cn']) background = background.replaceAll(host, origin)
  background = background.replaceAll('https://s.ee', origin)
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
  const startupPages = context.pages()
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/chrome_url_overrides/newtab.html`)
  for (const startup of startupPages) await startup.close()
  if (!quarkMode && !existingProfile && await page.getByRole('heading', { name: '连接收藏库' }).count() > 0) await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  return { context, page, profile, url: page.url() }
}

async function connect(page: Page, path = '/dav/', spaceTitle = '我的空间') {
  const fromSettings = await page.getByRole('heading', { name: '设置', exact: true }).count() > 0
  const onOnboarding = await page.getByRole('heading', { name: '连接收藏库' }).count() > 0
  if (!fromSettings && !onOnboarding) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
  }
  await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  const nickname = page.getByLabel('昵称', { exact: true })
  if (await nickname.count() > 0 && await nickname.isVisible()) {
    await nickname.fill('Rain')
  }
  await page.getByLabel('WebDAV 地址').fill(`${origin}${path}`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: /连接并开始|连接数据源/ }).click()
  const confirmMerge = page.getByRole('button', { name: '确认合并' })
  try {
    await confirmMerge.waitFor({ state: 'visible', timeout: 1500 })
    await confirmMerge.click()
  } catch {}
  const resolveBtn = page.getByRole('button', { name: /保留本地版本|保留远端版本/ })
  try {
    await resolveBtn.waitFor({ state: 'visible', timeout: 1500 })
    await resolveBtn.click()
  } catch {}
  if (fromSettings) {
    await expect(page.getByText(/上次同步：/).first()).toBeVisible()
  } else {
    if (!onOnboarding) {
      await page.getByRole('button', { name: spaceTitle }).first().click()
    }
    await expect(page.getByRole('heading', { name: spaceTitle, exact: true }).first()).toBeVisible()
  }
}

async function connectQuark(page: Page, spaceTitle = '我的空间') {
  const fromSettings = await page.getByRole('heading', { name: '设置', exact: true }).count() > 0
  const onOnboarding = await page.getByRole('heading', { name: '连接收藏库' }).count() > 0
  if (!fromSettings && !onOnboarding) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
  }
  await page.getByRole('button', { name: '夸克网盘', exact: true }).click()
  await page.getByRole('button', { name: /扫码登录夸克|重新扫码 \/ 切换账号/ }).click()
  await expect(page.getByLabel('夸克登录二维码')).toBeVisible()
  if (fromSettings) {
    await expect(page.getByText(/当前夸克账号：/)).toBeVisible()
  } else if (!onOnboarding) {
    await page.getByRole('button', { name: spaceTitle, exact: true }).click()
    await expect(page.getByRole('heading', { name: spaceTitle, exact: true })).toBeVisible()
  } else {
    await expect(page.getByRole('heading', { name: spaceTitle, exact: true })).toBeVisible()
  }
}

async function createCollection(page: Page, title: string) {
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  const colInput = page.getByRole('textbox', { name: '收藏块名称' })
  await colInput.fill(title)
  await colInput.press('Enter')
}

async function createSpace(page: Page, title: string) {
  await page.getByRole('button', { name: '新建空间', exact: true }).click()
  const spaceNav = page.getByRole('navigation', { name: '空间' })
  const spaceInput = spaceNav.getByRole('textbox', { name: '空间名称' })
  await spaceInput.fill(title)
  await spaceInput.press('Enter')
}

test('未登录默认进入本地收藏库：显示未连接云端、支持本地笔记与收藏、设置页隐藏同步按钮并支持连接与断开', async () => {
  const { page } = await openClient(undefined, true)
  // 1. 无全屏连接引导，直接进入工作台
  await expect(page.getByRole('heading', { name: '连接收藏库', exact: true })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
  await expect(page.getByText('日常收藏')).toBeVisible()
  // 2. 侧栏显示未连接云端
  await expect(page.getByText('未连接云端')).toBeVisible()
  // 3. 在未连接状态下可创建空间与收藏块
  await createCollection(page, '本地专属块')
  await expect(page.getByText('本地专属块')).toBeVisible()
  // 4. 进入设置页，断言状态及按钮可见性
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByText('当前为本地收藏库，仅保存在当前设备。如需多端同步或备份防丢，可连接网盘。')).toBeVisible()
  await expect(page.getByRole('button', { name: '立即同步' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '修复夸克同步' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '断开云端同步' })).toHaveCount(0)
  // 5. 导出备份可用
  await expect(page.getByRole('button', { name: '导出备份' })).toBeEnabled()
  // 6. 连接 WebDAV
  await connect(page)
  // 7. 已连接后，侧栏显示同步状态
  await expect(page.getByRole('button', { name: /已同步|正在同步|待同步/ })).toBeVisible()
  // 8. 进入设置页断言断开连接
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('button', { name: '立即同步' })).toBeVisible()
  await expect(page.getByRole('button', { name: '断开云端同步' })).toBeVisible()
  await page.getByRole('button', { name: '断开云端同步' }).click()
  await page.getByRole('button', { name: '确认断开' }).click()
  // 9. 断开后退回未连接云端，本地块保留
  await expect(page.getByText('未连接云端')).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).first().click()
  await expect(page.getByText('本地专属块')).toBeVisible()
})

test('从本地收藏库连接已有云端数据时触发合并确认，取消则保留本地，确认后双向合并', async () => {
  const remotePath = '/dav-merge/'
  const remoteDoc = {
    format: 'new-page',
    version: 1,
    entities: {
      profile: { id: 'profile', kind: 'profile', title: '云端用户', parentId: null, position: 1024, updatedAt: Date.now(), deletedAt: null, deletedBy: null, purged: false },
      'space-cloud': { id: 'space-cloud', kind: 'space', title: '云端空间', parentId: null, position: 1024, updatedAt: Date.now(), deletedAt: null, deletedBy: null, purged: false },
      'col-cloud': { id: 'col-cloud', kind: 'collection', title: '远端已有块', parentId: 'space-cloud', position: 1024, updatedAt: Date.now(), deletedAt: null, deletedBy: null, purged: false, collapsed: false },
    },
  }
  files.set(`${remotePath}new-page/data-v1.json`, { body: JSON.stringify(remoteDoc), revision: 1 })

  const { page } = await openClient(undefined, true)
  await createCollection(page, '本地独有块')
  await expect(page.getByText('本地独有块')).toBeVisible()

  // 进入设置连接该 WebDAV
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  const nickname = page.getByLabel('昵称', { exact: true })
  if (await nickname.count() > 0 && await nickname.isVisible()) {
    await nickname.fill('Rain')
  }
  await page.getByLabel('WebDAV 地址').fill(`${origin}${remotePath}`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: /连接并开始|连接数据源/ }).click()

  // 断言出现合并确认弹窗
  await expect(page.getByText('目标已有收藏。确认合并当前数据？已有内容会保留，冲突需要单独选择。')).toBeVisible()

  // 点击取消：保持本地状态
  await page.getByRole('button', { name: '取消' }).click()
  await expect(page.getByText('未连接云端')).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByText('本地独有块')).toBeVisible()

  // 再次提交并确认合并
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  const nickname2 = page.getByLabel('昵称', { exact: true })
  if (await nickname2.count() > 0 && await nickname2.isVisible()) {
    await nickname2.fill('Rain')
  }
  await page.getByLabel('WebDAV 地址').fill(`${origin}${remotePath}`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: /连接并开始|连接数据源/ }).click()
  await page.getByRole('button', { name: '确认合并' }).click()

  // 合并成功，解决冲突并切换为已同步状态，且两端空间和内容均存在
  await page.getByRole('button', { name: '保留本地版本' }).click()
  await expect(page.getByRole('button', { name: /已同步|正在同步|待同步/ })).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).first().click()
  await expect(page.getByText('本地独有块')).toBeVisible()
  await page.getByRole('button', { name: '云端空间', exact: true }).first().click()
  await expect(page.getByText('远端已有块')).toBeVisible()
})

test('s.ee 服务配置支持密钥显隐、夸克同步、备份及跨设备清除', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const key = page.getByLabel('s.ee API Key', { exact: true })
  await expect(key).toBeEnabled()
  await expect(key).toHaveAttribute('type', 'password')
  await key.fill('see-test-key-private')
  await page.getByRole('button', { name: '显示 s.ee API Key', exact: true }).click()
  await expect(key).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: '隐藏 s.ee API Key', exact: true }).click()
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(key).toHaveValue('see-test-key-private')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出备份', exact: true }).click()
  expect(await readFile((await (await download).path())!, 'utf8')).toContain('see-test-key-private')
  await page.setViewportSize({ width: 480, height: 900 })
  await key.scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480)
  await page.screenshot({ path: 'test-results/see-settings-narrow.png', fullPage: true })
  await page.setViewportSize({ width: 1500, height: 960 })
  await page.screenshot({ path: 'test-results/see-settings-desktop.png', fullPage: true })
  await sync(page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(second.page.getByLabel('s.ee API Key', { exact: true })).toHaveValue('see-test-key-private')
  await second.page.getByRole('button', { name: '清除 s.ee API Key', exact: true }).click()
  await expect(second.page.getByText('s.ee API Key 已清除', { exact: true })).toBeVisible()
  await sync(second.page)
  await sync(page)
  await expect(key).toHaveValue('')
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(key).toHaveValue('')
})

async function transferImage(page: Page, kind: 'paste' | 'drop' = 'paste', mime = 'image/png') {
  await page.getByRole('textbox', { name: 'Markdown 正文', exact: true }).evaluate((editor, { kind, mime }) => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['image-bytes'], 'picture.png', { type: mime }))
    const bounds = editor.getBoundingClientRect()
    const event = kind === 'paste'
      ? new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer })
      : new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: bounds.left + 20, clientY: bounds.top + 15 })
    editor.dispatchEvent(event)
  }, { kind, mime })
}

test('Toast 统一呈现提示，暂停自动关闭，并在弹窗内保持可操作和输入焦点', async () => {
  const { page } = await openClient()
  await connect(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-toast-test')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  const success = page.getByRole('status').filter({ hasText: 's.ee API Key 已保存' })
  await expect(success).toBeVisible()
  await success.hover()
  await page.clock.install()
  await page.clock.fastForward(6000)
  await expect(success).toBeVisible()
  await page.mouse.move(0, 0)
  await page.clock.fastForward(6000)
  await expect(success).toHaveCount(0)
  await page.clock.resume()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(page, 'Toast 测试')
  const card = page.getByRole('article', { name: '链接 Toast 测试', exact: true })
  await card.hover()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  const dialog = page.getByRole('dialog')
  const input = dialog.getByLabel('网址', { exact: true })
  await input.fill('javascript:alert(1)')
  const error = page.getByRole('alert').filter({ hasText: '请输入网页' })
  await expect(error).toBeVisible()
  await expect(input).toBeFocused()
  await expect(error).toHaveCount(1)
  await page.setViewportSize({ width: 480, height: 900 })
  const bounds = (await error.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(480)
  await page.screenshot({ path: 'test-results/toast-modal-narrow.png', fullPage: true })
  await error.getByRole('button', { name: '关闭提示', exact: true }).click()
  await expect(error).toHaveCount(0)
  await expect(dialog).toBeVisible()
  await input.fill('javascript:alert(2)')
  await expect(error).toBeVisible()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(error).toHaveCount(0)
  await expect(card.getByRole('link')).toHaveAttribute('href', 'https://react.dev/')
})

test('Tooltip 纯图标按钮悬停显示说明，排除删除与关闭，点击或 Esc 立即关闭', async () => {
  const { page } = await openClient()
  await connect(page)

  const expectTooltipNear = async (tooltip: Locator, target: Locator, expectedText: string) => {
    await expect(tooltip).toHaveText(expectedText)
    await expect(tooltip).toBeVisible()
    const tooltipBox = await tooltip.boundingBox()
    const targetBox = await target.boundingBox()
    expect(tooltipBox).not.toBeNull()
    expect(targetBox).not.toBeNull()
    if (tooltipBox && targetBox) {
      // 校验浮层没有卡死在页面左上角 (0, 0)
      expect(tooltipBox.x).toBeGreaterThan(10)
      expect(tooltipBox.y).toBeGreaterThan(10)
      // 校验水平方向与目标按钮邻近对齐
      const tooltipCenterX = tooltipBox.x + tooltipBox.width / 2
      const targetCenterX = targetBox.x + targetBox.width / 2
      expect(Math.abs(tooltipCenterX - targetCenterX)).toBeLessThan(Math.max(tooltipBox.width, targetBox.width) + 30)
      // 校验垂直方向位于按钮上方或下方邻近（40px 以内）
      const isAbove = Math.abs(tooltipBox.y + tooltipBox.height - targetBox.y) < 40
      const isBelow = Math.abs(targetBox.y + targetBox.height - tooltipBox.y) < 40
      expect(isAbove || isBelow).toBe(true)
    }
  }

  const collection = page.getByRole('region', { name: /^收藏块 日常收藏/ })
  await expect(collection).toBeVisible()

  // 1. 收藏块工具栏上的图标按钮
  const newNoteBtn = collection.getByRole('button', { name: '新建笔记 日常收藏' })
  await newNoteBtn.hover()
  const tooltip = page.getByRole('tooltip')
  await expectTooltipNear(tooltip, newNoteBtn, '新建笔记')
  await expect(newNoteBtn).not.toHaveAttribute('title')

  // 按 Esc 键，Tooltip 立即关闭
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)

  // 重命名按钮已去掉，改为双击标题行内编辑
  await expect(collection.getByRole('button', { name: '重命名 日常收藏' })).toHaveCount(0)

  // 悬停在 "折叠" 图标按钮上
  const collapseBtn = collection.getByRole('button', { name: '折叠 日常收藏' })
  await collapseBtn.hover()
  await expectTooltipNear(tooltip, collapseBtn, '折叠收藏块')

  // 点击折叠按钮后，Tooltip 立即关闭
  await collapseBtn.click()
  await expect(tooltip).toHaveCount(0)

  // 悬停在 "删除收藏块" 图标按钮上：排除项，不展示 Tooltip
  const deleteCollectionBtn = collection.getByRole('button', { name: '删除 日常收藏' })
  await deleteCollectionBtn.hover()
  await expect(tooltip).toHaveCount(0)

  // 2. 侧边栏空间管理图标按钮
  const newSpaceBtn = page.getByRole('button', { name: '新建空间' })
  await newSpaceBtn.hover()
  await expectTooltipNear(tooltip, newSpaceBtn, '新建空间')

  // 空间重命名按钮已去掉，改为双击行内编辑
  await expect(page.getByRole('button', { name: '重命名空间 我的空间' })).toHaveCount(0)

  // 测试键盘 Tab 聚焦与 Esc 关闭
  await newSpaceBtn.focus()
  await expectTooltipNear(tooltip, newSpaceBtn, '新建空间')
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)

  // 点击搜索收藏打开弹窗，测试通用弹窗关闭按钮（排除项，不展示 Tooltip）
  const searchBtn = page.getByRole('button', { name: '搜索收藏' })
  await searchBtn.click()
  const modalCloseBtn = page.getByRole('button', { name: '关闭弹窗' })
  await modalCloseBtn.hover()
  await expect(tooltip).toHaveCount(0)
  await modalCloseBtn.click()

  // 3. 待选区域头部按钮（包含禁用状态下的提示与原生 title 移除）
  const collectBtn = page.getByRole('button', { name: '一键收藏' })
  await expect(collectBtn).toBeDisabled()
  await collectBtn.hover()
  await expectTooltipNear(tooltip, collectBtn, '一键收藏全部网页')
  await expect(collectBtn).not.toHaveAttribute('title')

  const groupBtn = page.getByRole('button', { name: '一键分组' })
  await expect(groupBtn).toBeDisabled()
  await groupBtn.hover()
  await expectTooltipNear(tooltip, groupBtn, '一键分组全部网页')
  await expect(groupBtn).not.toHaveAttribute('title')

  // 4. 卡片悬浮操作按钮
  const expandBtn = collection.getByRole('button', { name: '展开 日常收藏' })
  await expandBtn.hover()
  await expectTooltipNear(tooltip, expandBtn, '展开收藏块')
  await expandBtn.click() // 重新展开日常收藏
  await expect(tooltip).toHaveCount(0)
  await addLink(page, 'Tooltip 测试链接')
  const card = page.getByRole('article', { name: '链接 Tooltip 测试链接' })
  await card.hover()

  const editLinkBtn = card.getByRole('button', { name: '编辑链接' })
  await editLinkBtn.hover()
  await expectTooltipNear(tooltip, editLinkBtn, '编辑链接')

  const todoBtn = card.getByRole('button', { name: '加入待办' })
  await todoBtn.hover()
  await expectTooltipNear(tooltip, todoBtn, '加入待办')

  // 点击加入待办，测试动态切换为移出待办
  await todoBtn.click()
  await page.mouse.move(0, 0)
  const untodoBtn = card.getByRole('button', { name: '移出待办' })
  await untodoBtn.hover()
  await expectTooltipNear(tooltip, untodoBtn, '移出待办')

  // 删除链接图标（排除项，不展示 Tooltip）
  const deleteLinkBtn = card.getByRole('button', { name: '删除链接' })
  await deleteLinkBtn.hover()
  await expect(tooltip).toHaveCount(0)
})

test('s.ee 图片粘贴使用最新全局密钥，失败可重试，直链随 Markdown 导出并重开', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const uploads: { authorization: string | undefined; body: string; contentType: string | undefined }[] = []
  let failure = false
  await context.route('https://s.ee/api/v1/file/upload', async route => {
    const request = route.request()
    uploads.push({ authorization: request.headers().authorization, contentType: request.headers()['content-type'], body: request.postData() ?? '' })
    await route.fulfill({ status: failure ? 401 : 200, contentType: 'application/json', body: JSON.stringify(failure
      ? { code: -1, message: 'Unauthorized see-test-key' }
      : { code: 200, message: 'success', success: true, data: { url: 'https://images.example.test/upload.png', upload_status: 2 } }) })
  })
  await context.route('https://images.example.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="#a2bc8b"/><text x="40" y="130" font-size="30">s.ee image</text></svg>' }))
  const note = await newNote(page, context, '图床手记', '上传前的正文')
  const editor = note.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await editor.press('Control+End')
  await editor.press('Enter')
  await editor.pressSequentially('/image')
  await expect(note.getByText('Image', { exact: true })).toHaveCount(0)
  for (let i = 0; i < 6; i++) await editor.press('Backspace')
  await transferImage(note)
  await transferImage(note, 'drop')
  await expect(note.getByRole('alert')).toHaveCount(0)
  await expect(note.getByText('Upload in progress...', { exact: true })).toHaveCount(0)
  await expect(note.locator('img')).toHaveCount(0)
  expect(uploads).toHaveLength(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-test-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  failure = true
  await transferImage(note)
  await expect(note.getByRole('alert')).toContainText('Unauthorized [已隐藏]')
  await expect(note.getByRole('alert')).not.toContainText('see-test-key')
  await expect(note.getByText('Upload in progress...', { exact: true })).toHaveCount(0)
  failure = false
  await transferImage(note)
  await expect(note.locator('img[src="https://images.example.test/upload.png"]')).toBeVisible()
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  expect(uploads).toHaveLength(2)
  expect(uploads[1].authorization).toBe('Bearer see-test-key')
  expect(uploads[1].contentType).toContain('multipart/form-data; boundary=')
  expect(uploads[1].body).toContain('name="file"; filename="picture.png"')
  expect(uploads[1].body).toContain('Content-Type: image/png')
  expect(uploads[1].body).toContain('image-bytes')
  const download = note.waitForEvent('download')
  await note.getByRole('button', { name: '导出 Markdown', exact: true }).click()
  const markdown = await readFile((await (await download).path())!, 'utf8')
  expect(markdown).toContain('上传前的正文')
  expect(markdown).toMatch(/!\[[^\]]*\]\(https:\/\/images\.example\.test\/upload\.png(?: "[^"]*")?\)/)
  expect(markdown).not.toMatch(/see-test-key|blob:|data:/)
  await note.reload()
  await expect(note.locator('img[src="https://images.example.test/upload.png"]')).toBeVisible()
  await note.screenshot({ path: 'test-results/see-note-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '清除 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已清除', { exact: true })).toBeVisible()
  await expect(note.locator('.milkdown-image-block')).toHaveCount(0)
  await expect(note.locator('img[src="https://images.example.test/upload.png"]')).toBeVisible()
  await expect(note.getByText('上传图片', { exact: true })).toHaveCount(0)
  await transferImage(note)
  await transferImage(note, 'drop')
  await expect(note.getByRole('alert')).toHaveCount(0)
  expect(uploads).toHaveLength(2)
  await note.reload()
  await expect(note.locator('img[src="https://images.example.test/upload.png"]')).toBeVisible()
})

test('s.ee 自动清理正文移除的图片和整篇删除笔记的图片', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-cleanup-test')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  let uploads = 0
  await context.route('https://s.ee/api/v1/file/upload', route => {
    const image = { url: `https://images.example.test/cleanup-${++uploads}.png`, hash: `cleanup-hash-${uploads}` }
    imageHistory.push(image)
    // The second upload exercises recovery for old responses with only a URL.
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data: uploads === 1 ? image : { url: image.url } }) })
  })
  await context.route('https://images.example.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>' }))
  async function finishCleanup() {
    const result = await page.evaluate(async () => {
      const key = 'new-page.workspace.v1'
      const root = (await chrome.storage.local.get(key))[key] as StoredWorkspace
      root.imageCleanup?.forEach(job => { job.notBefore = 0 })
      await chrome.storage.local.set({ [key]: root })
      return chrome.runtime.sendMessage({ type: 'sync', sourceId: root.active })
    })
    expect(result.ok).toBe(true)
    expect(result.snapshot.error).toBe('')
  }
  const first = await newNote(page, context, '正文删图', '保留正文')
  await transferImage(first)
  await expect(first.locator('img[src="https://images.example.test/cleanup-1.png"]')).toBeVisible()
  await expect(first.getByRole('status')).toContainText('已保存到本机')
  await first.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('图片已经移除')
  await expect.poll(() => page.evaluate(async () => ((await chrome.storage.local.get('new-page.workspace.v1'))['new-page.workspace.v1'] as StoredWorkspace).imageCleanup?.length ?? 0)).toBe(1)
  expect(imageDeletes).toEqual([])
  await finishCleanup()
  expect(imageDeletes).toEqual(['cleanup-hash-1'])
  await expect(first.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('图片已经移除')

  const second = await newNote(page, context, '整篇删图', '第二篇正文')
  await transferImage(second)
  await expect(second.locator('img[src="https://images.example.test/cleanup-2.png"]')).toBeVisible()
  await expect(second.getByRole('status')).toContainText('已保存到本机')
  await page.getByRole('article', { name: '笔记 整篇删图', exact: true }).getByRole('button', { name: '删除笔记', exact: true }).click({ force: true })
  await expect(second.getByRole('alert')).toContainText('永久删除')
  await finishCleanup()
  expect(imageDeletes).toEqual(['cleanup-hash-1', 'cleanup-hash-2'])
})

test('s.ee 本地删图在通知失败后保留磁盘保存并重开补发清理', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-cleanup-test')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  const image = { url: 'https://images.example.test/local-cleanup.png', hash: 'local-cleanup-hash' }
  imageHistory.push(image)
  await context.route('https://s.ee/api/v1/file/upload', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data: image }) }))
  await context.route('https://images.example.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="green"/></svg>' }))
  const title = '清理通知重试.md'
  const doc = await dropLocalFile(page, context, title, '本地保存正文')
  const editor = doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await editor.click()
  await editor.press('Control+End')
  await transferImage(doc)
  await expect(doc.locator(`img[src="${image.url}"]`)).toBeVisible()
  const diskBody = () => doc.evaluate(async name => (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).text(), title)
  await expect.poll(diskBody).toContain(image.url)
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  await doc.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    let failNextCleanup = true
    chrome.runtime.sendMessage = ((message: { type?: string; previous?: string }) => {
      if (failNextCleanup && message.type === 'local-image-document' && message.previous !== undefined) {
        failNextCleanup = false
        return Promise.reject(new Error('模拟图床通知暂时不可用'))
      }
      return send(message)
    }) as typeof chrome.runtime.sendMessage
  })
  await doc.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('移除图片后的正文')
  await expect(doc.getByRole('alert')).toContainText('文件已保存；图床清理通知待重试')
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  await expect.poll(diskBody).toContain('移除图片后的正文')
  expect(await diskBody()).not.toContain(image.url)
  const pending = await doc.evaluate(async () => {
    const id = new URLSearchParams(location.search).get('local')!
    return new Promise<{ pending: { before: string; after: string }[]; baseline: string; dirty?: boolean }>((resolveRead, reject) => {
      const request = indexedDB.open('page-garden-documents', 1)
      request.onsuccess = () => {
        const db = request.result, read = db.transaction('files').objectStore('files').get(id)
        read.onsuccess = () => { const file = read.result; db.close(); resolveRead({ pending: file.pendingImageCleanup ?? [], baseline: file.baseline, dirty: file.dirty }) }
        read.onerror = () => { db.close(); reject(read.error) }
      }
      request.onerror = () => reject(request.error)
    })
  })
  expect(pending.pending).toHaveLength(1)
  expect(pending.pending[0].before).toContain(image.url)
  expect(pending.pending[0].after).toContain('移除图片后的正文')
  expect(pending.baseline).toContain('移除图片后的正文')
  expect(pending.dirty).toBe(false)
  expect(imageDeletes).toEqual([])
  await doc.reload()
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('移除图片后的正文')
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  await expect(doc.getByRole('alert')).toHaveCount(0)
  await expect(doc.getByRole('button', { name: '保留编辑版本', exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(async () => ((await chrome.storage.local.get('new-page.workspace.v1'))['new-page.workspace.v1'] as StoredWorkspace).imageCleanup?.some(job => job.url === 'https://images.example.test/local-cleanup.png') ?? false)).toBe(true)
  const result = await page.evaluate(async () => {
    const key = 'new-page.workspace.v1', root = (await chrome.storage.local.get(key))[key] as StoredWorkspace
    root.imageCleanup?.forEach(job => { job.notBefore = 0 })
    await chrome.storage.local.set({ [key]: root })
    return chrome.runtime.sendMessage({ type: 'sync', sourceId: root.active })
  })
  expect(result.ok).toBe(true)
  expect(result.snapshot.error).toBe('')
  expect(imageDeletes).toEqual(['local-cleanup-hash'])
})

test('s.ee 本地可写 Markdown 支持拖放及原生上传按钮，并拒绝非图片', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-local-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  let uploads = 0
  await context.route('https://s.ee/api/v1/file/upload', async route => {
    uploads++
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data: { url: `https://images.example.test/${uploads}.png` } }) })
  })
  await context.route('https://images.example.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#a2bc8b"/></svg>' }))
  const doc = await dropLocalFile(page, context, '图床本地.md', '本地正文')
  const editor = doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await expect(editor).toHaveAttribute('contenteditable', 'true')
  await transferImage(doc, 'drop')
  await expect(doc.locator('img[src="https://images.example.test/1.png"]')).toBeVisible()
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  await editor.press('Control+End')
  await editor.press('Enter')
  await editor.pressSequentially('/image')
  await doc.getByText('Image', { exact: true }).click()
  const picker = doc.locator('input[type="file"][accept="image/*"]').last()
  await picker.setInputFiles({ name: 'not-an-image.txt', mimeType: 'text/plain', buffer: Buffer.from('text') })
  await expect(doc.getByRole('alert')).toContainText('请选择图片文件')
  expect(uploads).toBe(1)
  await picker.setInputFiles({ name: 'selected.png', mimeType: 'image/png', buffer: Buffer.from('selected-image') })
  await expect(doc.locator('img[src="https://images.example.test/2.png"]')).toBeVisible()
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  const disk = await doc.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('图床本地.md')).getFile()).text())
  expect(disk).toContain('https://images.example.test/1.png')
  expect(disk).toContain('https://images.example.test/2.png')
  expect(disk).not.toMatch(/see-local-key|blob:/)
  await doc.reload()
  await expect(doc.locator('img[src="https://images.example.test/1.png"]')).toBeVisible()
  await expect(doc.locator('img[src="https://images.example.test/2.png"]')).toBeVisible()
  await doc.setViewportSize({ width: 480, height: 900 })
  expect(await doc.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480)
  await doc.screenshot({ path: 'test-results/see-local-narrow.png', fullPage: true })
})

test('s.ee 拒绝业务失败、非 JSON 及危险图片地址，失败后不插入内容', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-validation-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  let body = ''
  let uploads = 0
  await context.route('https://s.ee/api/v1/file/upload', route => { uploads++; return route.fulfill({ contentType: 'application/json', body }) })
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  const note = await newNote(page, context, '错误恢复', '仍然保留的正文')
  for (const response of [
    { code: -1, message: '上传额度不足' },
    { code: 200, data: { url: 'javascript:alert(1)' } },
    { code: 200, success: false, data: { url: 'https://images.example.test/failed.png', upload_status: 0 } },
    '<html>Bad gateway</html>',
  ]) {
    body = typeof response === 'string' ? response : JSON.stringify(response)
    await transferImage(note)
    await expect(note.getByRole('alert')).toContainText('s.ee 图片上传失败')
    await expect(note.getByText('Upload in progress...', { exact: true })).toHaveCount(0)
    await expect(note.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('仍然保留的正文')
    await expect(note.locator('.milkdown img')).toHaveCount(0)
  }
  await transferImage(note, 'paste', 'text/plain')
  await expect(note.getByText('Upload in progress...', { exact: true })).toHaveCount(0)
  expect(uploads).toBe(4)
})

test('s.ee 上传期间交接编辑权会取消请求，只读文档不发起上传', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-handoff-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()
  let release!: () => void
  const response = new Promise<void>(resolveResponse => { release = resolveResponse })
  let uploads = 0
  await context.route('https://s.ee/api/v1/file/upload', async route => {
    uploads++
    await response
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ code: 200, data: { url: 'https://images.example.test/late.png' } }) }).catch(() => {})
  })
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  const first = await newNote(page, context, '上传交接', '交接正文')
  const second = await context.newPage()
  await second.goto(first.url())
  await expect(second.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveAttribute('contenteditable', 'false')
  await transferImage(second)
  await expect(second.getByText('Upload in progress...', { exact: true })).toHaveCount(0)
  expect(uploads).toBe(0)
  await transferImage(first)
  await expect.poll(() => uploads).toBe(1)
  const cancelled = context.waitForEvent('requestfailed', request => request.url() === 'https://s.ee/api/v1/file/upload')
  await second.getByRole('button', { name: '在此编辑', exact: true }).click()
  await cancelled
  release()
  await expect(first.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveAttribute('contenteditable', 'false')
  await second.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('接管后继续编辑')
  await expect(second.getByRole('status')).toContainText('已保存到本机')
  await expect(first.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('接管后继续编辑')
  await expect(first.locator('.milkdown img')).toHaveCount(0)
  await expect(second.locator('.milkdown img')).toHaveCount(0)
  expect(uploads).toBe(1)
})

test('s.ee 原生图片上传不会改写本地 Markdown 中既有图片的替代文本和标题', async () => {
  const { page, context } = await openClient(undefined, true)
  await context.route('https://images.example.test/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>' }))
  const doc = await dropLocalFile(page, context, '既有图片.md', '原始正文')
  await doc.evaluate(async () => {
    const file = await (await navigator.storage.getDirectory()).getFileHandle('既有图片.md')
    const writer = await file.createWritable()
    await writer.write('原始正文\n\n![示意图](https://images.example.test/original.png "原图标题")\n\n末尾正文\n')
    await writer.close()
  })
  await doc.reload()
  await expect(doc.locator('img[src="https://images.example.test/original.png"]')).toBeVisible()
  const editor = doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await editor.press('Control+End')
  await editor.press('Enter')
  await editor.pressSequentially('编辑后的正文')
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  const disk = await doc.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('既有图片.md')).getFile()).text())
  expect(disk).toContain('![示意图](https://images.example.test/original.png "原图标题")')
  expect(disk).toContain('编辑后的正文')
  await doc.reload()
  await expect(doc.getByRole('img', { name: '示意图', exact: true })).toHaveAttribute('title', '原图标题')
})

test('托管笔记新建后独立编辑、离线重开并导出正文', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const note = await opened
  await expect(note.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue('新笔记')
  await note.getByRole('textbox', { name: '笔记标题', exact: true }).fill('离线手记')
  await note.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('今天记录的正文')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  quark.unavailable = true
  await note.reload()
  await expect(note.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue('离线手记')
  await expect(note.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('今天记录的正文')
  const download = note.waitForEvent('download')
  await note.getByRole('button', { name: '导出 Markdown', exact: true }).click()
  const file = await download
  expect(file.suggestedFilename()).toBe('离线手记.md')
  expect((await readFile((await file.path())!, 'utf8')).trim()).toBe('今天记录的正文')
  await expect(page.getByRole('link', { name: '离线手记', exact: true })).toBeVisible()
})

test('笔记标题只在新建时默认赋值，清空后保存和重开仍为空', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const note = await opened
  const title = note.getByRole('textbox', { name: '笔记标题', exact: true })
  await expect(title).toHaveValue('新笔记')
  await title.fill('')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await expect(title).toHaveValue('')
  await note.reload()
  await expect(title).toHaveValue('')
  await title.pressSequentially('重新命名', { delay: 200 })
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await expect(title).toHaveValue('重新命名')
  await note.reload()
  await expect(title).toHaveValue('重新命名')
})

async function newNote(page: Page, context: BrowserContext, title: string, body: string) {
  const opened = context.waitForEvent('page')
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const note = await opened
  await note.getByRole('textbox', { name: '笔记标题', exact: true }).fill(title)
  await note.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill(body)
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  return note
}

async function expectCompactDocumentLayout(page: Page, titleLabel: string, heading: string) {
  const layout = await page.evaluate(({ titleLabel, heading }) => {
    const title = document.querySelector<HTMLInputElement>(`input[aria-label="${titleLabel}"]`)!.getBoundingClientRect()
    const surface = document.querySelector('main section')!.getBoundingClientRect()
    const editor = document.querySelector('.milkdown .ProseMirror')!.getBoundingClientRect()
    const firstHeading = [...document.querySelectorAll('.milkdown h1')].find(element => element.textContent === heading)!.getBoundingClientRect()
    return {
      width: innerWidth, height: innerHeight, surfaceWidth: surface.width,
      outerBottom: innerHeight - surface.bottom, editorBottom: surface.bottom - editor.bottom,
      titleGap: firstHeading.top - title.bottom,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    }
  }, { titleLabel, heading })
  if (layout.width >= 1000) expect(layout.surfaceWidth).toBeGreaterThan(layout.width * 0.7)
  expect(layout.outerBottom).toBeGreaterThanOrEqual(15)
  expect(layout.outerBottom).toBeLessThanOrEqual(25)
  expect(layout.editorBottom).toBeLessThanOrEqual(30)
  expect(layout.titleGap).toBeGreaterThanOrEqual(12)
  expect(layout.titleGap).toBeLessThanOrEqual(24)
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width)
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height)
}

test('笔记卡片自动摘要、全文搜索并与链接混排跨块移动', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, '前面的链接')
  await newNote(page, context, '可搜索的手记', '摘要文字 独有检索词')
  const card = page.getByRole('article', { name: '笔记 可搜索的手记', exact: true })
  await expect(card).toContainText('摘要文字 独有检索词')
  await expect(card.getByRole('button', { name: '删除笔记', exact: true })).toBeAttached()
  await expect(card.getByRole('button', { name: '加入 Todo', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索全部收藏', exact: true }).fill('独有检索词')
  await expect(page.getByRole('dialog').getByRole('link', { name: '可搜索的手记', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await createCollection(page, '笔记归档')
  const target = page.getByRole('region', { name: '收藏块 笔记归档', exact: true })
  await drag(page, card, target)
  await expect(target.getByRole('link', { name: '可搜索的手记', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('region', { name: '收藏块 笔记归档', exact: true }).getByRole('link', { name: '可搜索的手记', exact: true })).toBeVisible()
})

test('单篇笔记永久删除停止编辑，父级删除仍可恢复正文', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const note = await newNote(page, context, '永久删除手记', '待删除的正文')
  await page.getByRole('article', { name: '笔记 永久删除手记', exact: true }).getByRole('button', { name: '删除笔记', exact: true }).click({ force: true })
  await expect(note.getByRole('alert')).toContainText('永久删除')
  await expect(note.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveAttribute('readonly', '')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复 永久删除手记', exact: true })).toHaveCount(0)
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  const second = await newNote(page, context, '随父级恢复', '保留整组正文')
  await page.getByRole('button', { name: '删除 日常收藏', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await expect(second.getByRole('alert')).toContainText('回收站')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 日常收藏', exact: true }).click()
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await expect(second.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('保留整组正文')
  await expect(second.getByRole('textbox', { name: '笔记标题', exact: true })).not.toHaveAttribute('readonly', '')
})

test('同一笔记后开只读，接管后旧页停止写入', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const first = await newNote(page, context, '交接手记', '交接前的正文')
  const second = await context.newPage()
  await second.goto(first.url())
  await expect(second.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveAttribute('readonly', '')
  await second.getByRole('button', { name: '在此编辑', exact: true }).click()
  await expect(first.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveAttribute('readonly', '')
  await second.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('接管后的正文')
  await expect(second.getByRole('status')).toContainText('已保存到本机')
  await expect(first.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('接管后的正文')
  await second.close()
  await first.getByRole('button', { name: '在此编辑', exact: true }).click()
  await first.getByRole('textbox', { name: '笔记标题', exact: true }).fill('重新编辑')
  await expect(first.getByRole('status')).toContainText('已保存到本机')
})

test('笔记正文夸克同步、冲突选择和完整备份往返', async () => {
  test.setTimeout(90_000)
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  const one = await newNote(first.page, first.context, '同步笔记', '初始正文')
  await sync(first.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  const opened = second.context.waitForEvent('page')
  await second.page.getByRole('link', { name: '同步笔记', exact: true }).click()
  const two = await opened
  await expect(two.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('初始正文')
  quark.unavailable = true
  await one.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('设备一的正文')
  await two.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('设备二的正文')
  await expect(two.getByRole('status')).toContainText('已保存到本机')
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  quark.unavailable = false
  await sync(first.page)
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  const conflict = second.page.getByRole('article', { name: '冲突 同步笔记', exact: true })
  await expect(conflict).toContainText('设备一的正文')
  await expect(conflict).toContainText('设备二的正文')
  await conflict.getByRole('button', { name: '保留本地版本', exact: true }).click()
  await sync(second.page)
  const downloading = second.page.waitForEvent('download')
  await second.page.getByRole('button', { name: '导出备份', exact: true }).click()
  const backup = await readFile((await (await downloading).path())!, 'utf8')
  const restored = await openClient()
  await connect(restored.page, '/notes-backup/')
  await restored.page.getByRole('button', { name: '设置', exact: true }).click()
  await restored.page.getByLabel('导入备份').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from(backup) })
  await restored.page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await restored.page.getByRole('searchbox', { name: '搜索全部收藏', exact: true }).fill('同步笔记')
  await expect(restored.page.getByRole('article', { name: '笔记 同步笔记', exact: true })).toContainText('设备二的正文')
})

test('笔记直接编辑、静态背景和标题大纲定位', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const note = await newNote(page, context, '大纲手记', '正文')
  const body = note.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await body.fill('')
  await body.pressSequentially('# 一级章节', { delay: 30 })
  await body.press('Enter')
  await body.pressSequentially('## 二级章节', { delay: 30 })
  await expect(note.getByRole('navigation', { name: '文档大纲', exact: true }).getByRole('button', { name: '二级章节', exact: true })).toBeVisible()
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(note.getByRole('button', { name: /^(阅读模式|编辑模式)$/ })).toHaveCount(0)
  await expect(note.locator('canvas')).toHaveCount(0)
  await expect(page.locator('canvas')).toHaveCount(1)
  await expect(note.getByRole('button', { name: /打开本地|打开文件夹|文件目录/ })).toHaveCount(0)
  await note.getByRole('navigation', { name: '文档大纲', exact: true }).getByRole('button', { name: '二级章节', exact: true }).click()
  await expect(note.getByRole('heading', { name: '二级章节', exact: true })).toBeInViewport()
  const headingSize = (title: string) => note.getByRole('heading', { name: title, exact: true }).evaluate(element => parseFloat(getComputedStyle(element).fontSize))
  expect(await headingSize('一级章节')).toBeGreaterThan(await headingSize('二级章节'))
  expect(await headingSize('二级章节')).toBeGreaterThan(await body.evaluate(element => parseFloat(getComputedStyle(element).fontSize)))
  await expect(note.getByPlaceholder('Paste link...')).not.toBeVisible()
  for (const width of [1675, 1500, 960, 651, 650, 480]) {
    await note.setViewportSize({ width, height: width === 1675 ? 1243 : 900 })
    await expectCompactDocumentLayout(note, '笔记标题', '一级章节')
  }
  await note.setViewportSize({ width: 1675, height: 1243 })
  await note.screenshot({ path: 'test-results/document-desktop.png', fullPage: true })
  await note.setViewportSize({ width: 480, height: 900 })
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await expect(note.getByRole('button', { name: '导出 Markdown', exact: true })).toBeVisible()
  await note.screenshot({ path: 'test-results/document-mobile.png', fullPage: true })
  const editorBounds = (await body.boundingBox())!
  await body.click({ position: { x: 40, y: editorBounds.height - 16 } })
  await expect(body).toBeFocused()
  await body.fill(Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 行：长正文仍能自然向下滚动。`).join('\n'))
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  expect(await note.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(900)
  expect(await note.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480)
})

test('空文档按需加载编辑器，打开 Markdown 后仍提供代码语言高亮', async () => {
  const { page, context, profile } = await openClient(undefined, true)
  const doc = await context.newPage()
  const errors: string[] = []
  doc.on('pageerror', error => errors.push(error.message))
  const documentUrl = new URL('/document/index.html', page.url()).href
  await doc.goto(documentUrl)
  await expect(doc.getByRole('status')).toHaveText('请将 Markdown 文件拖入新标签页')
  const scripts = await doc.evaluate(() => performance.getEntriesByType('resource')
    .map(entry => entry.name).filter(url => new URL(url).pathname.endsWith('.js')))
  const sizes = await Promise.all(scripts.map(async url =>
    (await readFile(join(profile, 'extension', new URL(url).pathname.slice(1)))).length))
  expect(sizes.reduce((sum, size) => sum + size, 0), '空页不应预先加载整个编辑器').toBeLessThan(1024 * 1024)
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveCount(0)

  await doc.goto(`${documentUrl}?url=${encodeURIComponent(`${origin}/markdown/guide.MD`)}`)
  await expect(doc.getByRole('heading', { name: '阅读指南', exact: true })).toBeVisible()
  await expect(doc.locator('.cm-line')).toContainText(['const ready = true'])
  await expect.poll(() => doc.locator('.cm-line span').count()).toBeGreaterThan(0)
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveAttribute('contenteditable', 'false')
  expect(errors).toEqual([])
})

test('收藏在线 Markdown 使用独立阅读页并解析相对资源', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  // Collect the ordinary source tab with takeover off. Opening the saved link
  // must still choose the document reader independently of automatic takeover.
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true }).click()
  await expect(page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(page, '在线 Markdown', `${origin}/markdown/guide.MD?version=1#安装`)
  const opened = context.waitForEvent('page')
  await page.getByRole('link', { name: '在线 Markdown', exact: true }).click()
  const doc = await opened
  await expect(doc.getByRole('heading', { name: '阅读指南', exact: true })).toBeVisible()
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveAttribute('contenteditable', 'false')
  await expect(doc.locator('canvas')).toHaveCount(0)
  await expect(doc.getByRole('textbox', { name: '文件名称', exact: true })).toHaveValue('guide.MD')
  await expect(doc.getByRole('button', { name: /打开本地|打开文件夹|文件目录|导出 Markdown/ })).toHaveCount(0)
  await expect(doc.getByRole('table').filter({ hasText: '列名' })).toContainText('通过')
  await expect(doc.getByRole('img', { name: '示意图', exact: true })).toHaveAttribute('src', `${origin}/markdown/figure.svg`)
  await doc.getByRole('link', { name: '下一篇', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '下一篇', exact: true })).toBeVisible()
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('关联文件正文')
})

test('Markdown 主页面默认接管，md 后缀的 HTML 保留原网页且不接管子框架', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const doc = await context.newPage()
  await doc.goto(`${origin}/markdown/guide.MD?version=1#安装`).catch(() => {})
  await expect(doc.getByRole('heading', { name: '阅读指南', exact: true })).toBeVisible()
  expect(new URL(doc.url()).searchParams.get('url')).toBe(new URL(`${origin}/markdown/guide.MD?version=1#安装`).href)
  await doc.goto(`${origin}/markdown/html.md`).catch(() => {})
  await expect(doc.getByRole('heading', { name: '原始网页', exact: true })).toBeVisible()
  await expect(doc).toHaveURL(`${origin}/markdown/html.md`)
  await doc.goto(`${origin}/web/guide`)
  await doc.evaluate(url => { const iframe = document.createElement('iframe'); iframe.src = url; document.body.append(iframe) }, `${origin}/markdown/html.md`)
  await expect(doc.frameLocator('iframe').getByRole('heading', { name: '原始网页', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true }).click()
  await expect(page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true })).toBeEnabled()
  await doc.goto(`${origin}/markdown/html.md`)
  await expect(doc.getByRole('heading', { name: '原始网页', exact: true })).toBeVisible()
})

test('收藏中 md 后缀的 HTML 自动打开原网页', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  await page.evaluate(() => chrome.storage.local.set({ markdownTakeover: false }))
  await addLink(page, 'GitHub 文件页面', `${origin}/markdown/html.md`)
  for (const enabled of [true, false]) {
    await page.evaluate(markdownTakeover => chrome.storage.local.set({ markdownTakeover }), enabled)
    const opened = context.waitForEvent('page')
    await page.getByRole('link', { name: 'GitHub 文件页面', exact: true }).click()
    const doc = await opened
    await expect(doc.getByRole('heading', { name: '原始网页', exact: true })).toBeVisible()
    await expect(doc).toHaveURL(`${origin}/markdown/html.md`)
    await doc.close()
  }
})

test('Markdown 接管识别纯文本 MIME，跳转与伪装纯文本的 HTML 保留原网页', async () => {
  const { context } = await openClient(undefined, true)
  const doc = await context.newPage()
  for (const name of ['plain.md', 'legacy.md']) {
    await doc.goto(`${origin}/markdown/${name}`).catch(() => {})
    await expect(doc.getByRole('heading', { name: '阅读指南', exact: true })).toBeVisible()
    expect(new URL(doc.url()).searchParams.get('url')).toBe(`${origin}/markdown/${name}`)
  }
  for (const name of ['redirect.md', 'sniffed.md']) {
    await doc.goto(`${origin}/markdown/${name}`).catch(() => {})
    await expect(doc).toHaveURL(`${origin}/markdown/${name === 'redirect.md' ? 'html.md' : name}`)
    if (name === 'redirect.md') await expect(doc.getByRole('heading', { name: '原始网页', exact: true })).toBeVisible()
    else await expect(doc.locator('body > pre')).toContainText('<h1>原始网页</h1>')
  }
})

async function dropLocalFile(page: Page, context: BrowserContext, title: string, body: string) {
  const opened = context.waitForEvent('page')
  await page.evaluate(async ({ title, body }) => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(title, { create: true })
    const writer = await handle.createWritable(); await writer.write(body); await writer.close()
    const transfer = new DataTransfer()
    transfer.items.add(await handle.getFile())
    Object.defineProperty(DataTransferItem.prototype, 'getAsFileSystemHandle', { configurable: true, value: async () => handle })
    document.querySelector('main, .workbench')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  }, { title, body })
  const doc = await opened
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText(body)
  return doc
}

async function openFileDirectoryFixture() {
  const client = await openClient(undefined, true)
  const directory = join(client.profile, '文档 目录')
  await mkdir(join(directory, '章节', '更深一层'), { recursive: true })
  await mkdir(join(directory, '空目录'))
  await writeFile(join(directory, '当前文档.md'), '# 当前标题\n\n当前正文')
  await writeFile(join(directory, '同级 #100%.MARKDOWN'), '# 同级标题\n\n[子文件](./章节/子文件.md)')
  await writeFile(join(directory, '隐藏.txt'), '不显示')
  await writeFile(join(directory, '章节', '子文件.md'), '# 子文件标题\n\n子目录正文')
  await writeFile(join(directory, '章节', '隐藏图片.png'), '不显示')
  await writeFile(join(directory, '章节', '更深一层', "深入'文件(1).md"), '# 深入标题')
  await client.context.addInitScript(() => {
    Object.assign(window, { showDirectoryPicker: () => { throw new Error('不应打开授权选择器') } })
    Object.assign(FileSystemDirectoryHandle.prototype, { requestPermission: () => { throw new Error('不应申请目录授权') } })
    const allowed = chrome.extension.isAllowedFileSchemeAccess.bind(chrome.extension)
    chrome.extension.isAllowedFileSchemeAccess = (() => localStorage.getItem('denyFileAccess') ? Promise.resolve(false) : allowed()) as typeof allowed
    const fetchFile = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      if (url.startsWith('file:') && url.endsWith('/')) {
        const reads = JSON.parse(localStorage.getItem('directoryReads') ?? '[]') as string[]
        localStorage.setItem('directoryReads', JSON.stringify([...reads, url]))
      }
      return fetchFile(input, init)
    }
  })
  const doc = await client.context.newPage()
  const url = new URL('/document/index.html', client.page.url())
  const fileUrl = pathToFileURL(join(directory, '当前文档.md')).href
  url.searchParams.set('url', fileUrl)
  await doc.goto(url.href)
  await expect(doc.getByRole('heading', { name: '当前标题', exact: true })).toBeVisible()
  return { ...client, doc, directory, fileUrl }
}

test('本地目录直接读取真实文件列表，仅展开时读取子目录并切换 Markdown', async () => {
  const { doc, directory, fileUrl } = await openFileDirectoryFixture()
  const folder = doc.getByRole('button', { name: '文件目录', exact: true })
  const outline = doc.getByRole('button', { name: '文档大纲', exact: true })
  await folder.hover()
  await expect(doc.getByRole('tooltip')).toHaveText('文件目录')
  await expect(folder).not.toHaveAttribute('title')
  await outline.hover()
  await expect(doc.getByRole('tooltip')).toHaveText('文档大纲')
  await expect(outline).not.toHaveAttribute('title')
  await expect(outline).toHaveAttribute('aria-pressed', 'true')
  expect(await doc.evaluate(() => localStorage.getItem('directoryReads'))).toBeNull()
  await folder.focus(); await folder.press('Enter')
  await expect(doc.getByRole('button', { name: '打开 同级 #100%.MARKDOWN', exact: true })).toBeVisible()
  await expect(doc.getByRole('button', { name: '打开 当前文档.md', exact: true })).toHaveAttribute('aria-current', 'page')
  await expect(doc.getByText('隐藏.txt', { exact: true })).toHaveCount(0)
  await expect(doc.getByRole('button', { name: '打开 子文件.md', exact: true })).toHaveCount(0)
  expect(await doc.evaluate(() => JSON.parse(localStorage.getItem('directoryReads')!))).toEqual([new URL('.', fileUrl).href])
  await doc.getByRole('button', { name: '文件夹 章节', exact: true }).click()
  await expect(doc.getByRole('button', { name: '打开 子文件.md', exact: true })).toBeVisible()
  await expect(doc.getByText('隐藏图片.png', { exact: true })).toHaveCount(0)
  expect(await doc.evaluate(() => JSON.parse(localStorage.getItem('directoryReads')!))).toHaveLength(2)
  await doc.getByRole('button', { name: '文件夹 更深一层', exact: true }).click()
  await expect(doc.getByRole('button', { name: "打开 深入'文件(1).md", exact: true })).toBeVisible()
  expect(await doc.evaluate(() => JSON.parse(localStorage.getItem('directoryReads')!))).toHaveLength(3)
  await doc.getByRole('button', { name: "打开 深入'文件(1).md", exact: true }).click()
  await expect(doc.getByRole('heading', { name: '深入标题', exact: true })).toBeVisible()
  await doc.getByRole('button', { name: '文件夹 更深一层', exact: true }).click()
  await doc.getByRole('button', { name: '文件夹 空目录', exact: true }).click()
  await expect(doc.getByText('此文件夹没有 Markdown 文件或子目录', { exact: true })).toBeVisible()
  await doc.getByRole('button', { name: '文件夹 空目录', exact: true }).click()
  await doc.getByRole('button', { name: '打开 同级 #100%.MARKDOWN', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveAttribute('contenteditable', 'false')
  expect(new URL(doc.url()).searchParams.get('url')).toBe(pathToFileURL(join(directory, '同级 #100%.MARKDOWN')).href)
  await doc.screenshot({ path: 'test-results/local-directory-desktop.png', fullPage: true })
  await doc.setViewportSize({ width: 480, height: 900 })
  await folder.hover()
  expect(await doc.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480)
  await doc.screenshot({ path: 'test-results/local-directory-narrow.png', fullPage: true })
  await outline.click()
  await expect(doc.getByRole('navigation', { name: '文档大纲', exact: true })).toBeVisible()
  await doc.getByRole('link', { name: '子文件', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '子文件标题', exact: true })).toBeVisible()
  await doc.reload()
  await expect(outline).toHaveAttribute('aria-pressed', 'true')
  await expect(doc.getByRole('heading', { name: '子文件标题', exact: true })).toBeVisible()
  await folder.click()
  await expect(doc.getByRole('button', { name: '打开 子文件.md', exact: true })).toHaveAttribute('aria-current', 'page')
})

test('本地 Markdown 切换文件后支持浏览器后退和前进', async () => {
  const { doc } = await openFileDirectoryFixture()
  const initial = doc.url()
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await doc.getByRole('button', { name: '打开 同级 #100%.MARKDOWN', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
  const sibling = doc.url()
  await doc.getByRole('link', { name: '子文件', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '子文件标题', exact: true })).toBeVisible()
  const child = doc.url()
  await doc.goBack()
  await expect(doc).toHaveURL(sibling)
  await expect(doc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
  await doc.goBack()
  await expect(doc).toHaveURL(initial)
  await expect(doc.getByRole('heading', { name: '当前标题', exact: true })).toBeVisible()
  await doc.goForward()
  await expect(doc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
  await doc.goForward()
  await expect(doc).toHaveURL(child)
  await expect(doc.getByRole('heading', { name: '子文件标题', exact: true })).toBeVisible()
  await doc.reload()
  await expect(doc.getByRole('heading', { name: '子文件标题', exact: true })).toBeVisible()
  await doc.goBack()
  await expect(doc).toHaveURL(sibling)
  await expect(doc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
})

for (const width of [1500, 480]) test(`切换本地 Markdown 期间保持正文位置且不闪现读取提示：${width}`, async () => {
  const { doc } = await openFileDirectoryFixture()
  await doc.setViewportSize({ width, height: 960 })
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  const title = doc.getByRole('textbox', { name: '文件名称', exact: true })
  const before = await title.boundingBox()
  const editor = await doc.getByRole('textbox', { name: 'Markdown 正文', exact: true }).elementHandle()
  await doc.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime)
    Object.assign(chrome.runtime, { sendMessage: async (message: { type: string }) => {
      if (message.type === 'read-markdown') await new Promise<void>(resolve => Object.assign(window, { releaseMarkdownRead: resolve }))
      return send(message)
    } })
  })
  await doc.getByRole('button', { name: '打开 同级 #100%.MARKDOWN', exact: true }).click()
  await expect.poll(() => doc.evaluate(() => typeof (window as Window & { releaseMarkdownRead?: () => void }).releaseMarkdownRead)).toBe('function')
  await expect(doc.getByText('正在读取…', { exact: true })).toHaveCount(0)
  await expect(doc.getByRole('heading', { name: '当前标题', exact: true })).toBeVisible()
  expect((await title.boundingBox())!.y).toBe(before!.y)
  await doc.screenshot({ path: `test-results/markdown-switch-pending-${width}.png`, fullPage: true })
  await doc.evaluate(() => (window as Window & { releaseMarkdownRead?: () => void }).releaseMarkdownRead!())
  await expect(doc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
  expect((await title.boundingBox())!.y).toBe(before!.y)
  expect(await editor!.evaluate(node => node.isConnected)).toBe(true)
  await doc.screenshot({ path: `test-results/markdown-switch-complete-${width}.png`, fullPage: true })
})

test('切换到相同正文的本地 Markdown 时按新文件位置解析相对链接', async () => {
  const { doc, directory, fileUrl } = await openFileDirectoryFixture()
  const body = '# 相同正文\n\n[目标文件](./target.md)'
  await writeFile(join(directory, '当前文档.md'), body)
  await writeFile(join(directory, '章节', '相同正文.md'), body)
  await doc.reload()
  const link = doc.getByRole('link', { name: '目标文件', exact: true })
  await expect(link).toHaveAttribute('href', new URL('target.md', fileUrl).href)
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await doc.getByRole('button', { name: '文件夹 章节', exact: true }).click()
  await doc.getByRole('button', { name: '打开 相同正文.md', exact: true }).click()
  await expect(doc.getByRole('textbox', { name: '文件名称', exact: true })).toHaveValue('相同正文.md')
  await expect(link).toHaveAttribute('href', new URL('章节/target.md', fileUrl).href)
})

test('本地目录未开启文件网址访问时提示打开设置，启用后可重试', async () => {
  const { doc, context } = await openFileDirectoryFixture()
  await doc.evaluate(() => localStorage.setItem('denyFileAccess', 'yes'))
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await expect(doc.getByRole('alert')).toContainText('允许访问文件网址')
  await expect(doc.getByRole('navigation', { name: '文档大纲', exact: true })).toBeVisible()
  await expect(doc.getByRole('heading', { name: '当前标题', exact: true })).toBeVisible()
  expect(await doc.evaluate(() => localStorage.getItem('directoryReads'))).toBeNull()
  await doc.screenshot({ path: 'test-results/local-directory-file-access.png', fullPage: true })
  const opened = context.waitForEvent('page')
  await doc.getByRole('button', { name: '打开扩展设置', exact: true }).click()
  const settings = await opened
  await expect(settings).toHaveURL(/chrome:\/\/extensions\/\?id=/)
  await settings.close()
  await doc.evaluate(() => localStorage.removeItem('denyFileAccess'))
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await expect(doc.getByRole('button', { name: '打开 当前文档.md', exact: true })).toBeVisible()
})

test('本地文档初次读取缺少文件网址访问权限时提示设置，开启后重试读取', async () => {
  const { doc } = await openFileDirectoryFixture()
  await doc.evaluate(() => localStorage.setItem('denyFileAccess', 'yes'))
  await doc.reload()
  await expect(doc.getByRole('alert')).toContainText('允许访问文件网址')
  await expect(doc.getByRole('button', { name: '打开扩展设置', exact: true })).toBeVisible()
  await doc.evaluate(() => localStorage.removeItem('denyFileAccess'))
  await doc.getByRole('button', { name: '重试读取', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '当前标题', exact: true })).toBeVisible()
})

test('本地目录读取失败后可重试，权限关闭时再次提示开启文件网址访问', async () => {
  const { doc, directory } = await openFileDirectoryFixture()
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await expect(doc.getByRole('button', { name: '文件夹 空目录', exact: true })).toBeVisible()
  await rmdir(join(directory, '空目录'))
  await doc.getByRole('button', { name: '文件夹 空目录', exact: true }).click()
  await expect(doc.getByRole('alert')).toBeVisible()
  await mkdir(join(directory, '空目录'))
  await doc.getByRole('button', { name: '重试', exact: true }).click()
  await expect(doc.getByText('此文件夹没有 Markdown 文件或子目录', { exact: true })).toBeVisible()
  await doc.getByRole('button', { name: '文件夹 空目录', exact: true }).click()
  await doc.evaluate(() => localStorage.setItem('denyFileAccess', 'yes'))
  await doc.getByRole('button', { name: '文件夹 章节', exact: true }).click()
  await expect(doc.getByRole('alert')).toContainText('允许访问文件网址')
})

test('拖入单个本地文件没有网址时提示通过文件网址打开，不弹出目录授权', async () => {
  const { page, context } = await openClient(undefined, true)
  await context.addInitScript(() => { Object.assign(window, { showDirectoryPicker: () => { throw new Error('不应打开目录授权') } }) })
  const doc = await dropLocalFile(page, context, '拖入正文.md', '原正文')
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await expect(doc.getByRole('alert')).toContainText('请通过本地文件网址打开')
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('原正文')
})


test('拖入 Markdown 在新标签页打开，文档只保留正文相关操作', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const originalUrl = page.url()
  const opened = context.waitForEvent('page')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['# 拖入的标题\n\n本地拖入正文'], '拖入手记.MD', { type: 'text/markdown' }))
    document.querySelector('.workbench')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  const doc = await opened
  await expect(doc).toHaveURL(/\/document\/index\.html\?local=/)
  await expect(page).toHaveURL(originalUrl)
  await expect(doc.getByRole('heading', { name: '拖入的标题', exact: true })).toBeVisible()
  await expect(doc.getByRole('textbox', { name: '文件名称', exact: true })).toHaveValue('拖入手记.MD')
  await expect(doc.getByRole('button', { name: /打开本地|打开文件夹|文件目录|授权编辑原文件|导出 Markdown/ })).toHaveCount(0)
  await expect(doc.getByText(/^(本地 Markdown|Markdown 阅读|Markdown 笔记)$/)).toHaveCount(0)
  await doc.reload()
  await expect(doc.getByRole('heading', { name: '拖入的标题', exact: true })).toBeVisible()
  await expectCompactDocumentLayout(doc, '文件名称', '拖入的标题')
  await doc.screenshot({ path: 'test-results/local-document-desktop.png', fullPage: true })
  await doc.setViewportSize({ width: 480, height: 900 })
  await expect(doc.getByRole('heading', { name: '拖入的标题', exact: true })).toBeVisible()
  await expectCompactDocumentLayout(doc, '文件名称', '拖入的标题')
  await doc.screenshot({ path: 'test-results/local-document-mobile.png', fullPage: true })
})

test('本地 Markdown 接管在后台响应较慢时也不显示原始文本', async () => {
  const { page, context, profile } = await openClient(undefined, true)
  const path = join(profile, '接管闪烁.md')
  await writeFile(path, '# 接管完成\n\n不应闪现的原始正文')
  const rawFrames: string[] = []
  context.on('console', message => { if (message.text().startsWith('RAW_MARKDOWN_FRAME')) rawFrames.push(message.text()) })
  await context.addInitScript(() => {
    if (location.protocol !== 'file:') return
    const inspect = () => {
      const pre = document.querySelector('body > pre')
      if (pre?.textContent && pre.getBoundingClientRect().height > 0 && getComputedStyle(pre).visibility === 'visible' && getComputedStyle(pre).display !== 'none') console.log('RAW_MARKDOWN_FRAME', pre.textContent)
      requestAnimationFrame(inspect)
    }
    requestAnimationFrame(inspect)
  })
  await context.serviceWorkers()[0]!.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local)
    Object.assign(chrome.storage.local, { get: async (key: string) => {
      if (key === 'markdownTakeover') await new Promise(resolve => setTimeout(resolve, 300))
      return get(key)
    } })
  })
  const opened = context.waitForEvent('page')
  const session = await context.newCDPSession(page)
  const data = { items: [], files: [path], dragOperationsMask: 1 }
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 750, y: 400, data })
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: 750, y: 400, data })
  await session.send('Input.dispatchDragEvent', { type: 'drop', x: 750, y: 400, data })
  const doc = await opened
  await expect(doc.getByRole('heading', { name: '接管完成', exact: true })).toBeVisible()
  expect(rawFrames).toEqual([])
})

test('本地文件早期接管在后台失败时恢复原文，其他格式和子框架保持可见', async () => {
  const { page, context, profile } = await openClient(undefined, true)
  const markdown = join(profile, '原始内容.MD'), plain = join(profile, '普通文本.txt'), html = join(profile, '本地框架.html')
  await writeFile(markdown, '# 本地原始内容')
  await writeFile(plain, '普通文本内容')
  await writeFile(html, '<iframe src="./原始内容.MD"></iframe>')
  await context.serviceWorkers()[0]!.evaluate(() => {
    const get = chrome.storage.local.get.bind(chrome.storage.local)
    Object.assign(chrome.storage.local, { get: (key: string) => key === 'markdownTakeover' ? Promise.reject(new Error('测试读取设置失败')) : get(key) })
  })
  const doc = await context.newPage()
  await doc.goto(pathToFileURL(markdown).href)
  await expect(doc.locator('body > pre')).toBeVisible()
  await expect(doc.locator('body > pre')).toContainText('# 本地原始内容')
  await doc.goto(pathToFileURL(plain).href)
  await expect(doc.locator('body > pre')).toBeVisible()
  await expect(doc.locator('body > pre')).toContainText('普通文本内容')
  await doc.goto(pathToFileURL(html).href)
  await expect(doc.frameLocator('iframe').locator('body > pre')).toBeVisible()
  await expect(doc.frameLocator('iframe').locator('body > pre')).toContainText('# 本地原始内容')
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()
})

for (const mode of ['未连接收藏库', '已连接收藏库', '关闭自动接管', '缺少文件网址权限'] as const) test(`Chrome 原生本地文件拖放保留文件网址：${mode}`, async () => {
  const { page, context, profile } = await openClient(undefined, true)
  const path = join(profile, '原生 拖入 #100%.markdown')
  await writeFile(path, '# 原生拖放标题\n\n来自本地文件夹的正文')
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()
  if (mode === '已连接收藏库') await connectQuark(page)
  if (mode === '关闭自动接管') await page.evaluate(() => chrome.storage.local.set({ markdownTakeover: false }))
  if (mode === '缺少文件网址权限') await context.addInitScript(() => { chrome.extension.isAllowedFileSchemeAccess = (() => Promise.resolve(false)) as typeof chrome.extension.isAllowedFileSchemeAccess })
  const originalUrl = page.url()
  // A native file URL opens without requesting filesystem handle permissions.
  await page.evaluate(() => { Object.assign(FileSystemFileHandle.prototype, { requestPermission: () => { throw new Error('不应申请文件句柄授权') } }) })
  const opened = context.waitForEvent('page')
  const session = await context.newCDPSession(page)
  const data = { items: [], files: [path], dragOperationsMask: 1 }
  await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 750, y: 400, data })
  await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: 750, y: 400, data })
  await session.send('Input.dispatchDragEvent', { type: 'drop', x: 750, y: 400, data })
  const doc = await opened
  await expect(page).toHaveURL(originalUrl)
  if (mode === '关闭自动接管') {
    await expect(doc).toHaveURL(url => decodeURI(url.href) === decodeURI(pathToFileURL(path).href))
    await expect(doc.locator('body')).toContainText('来自本地文件夹的正文')
    return
  }
  if (mode === '缺少文件网址权限') {
    await expect(doc.getByRole('alert')).toContainText('允许访问文件网址')
    await expect(doc.getByRole('button', { name: '打开扩展设置', exact: true })).toBeVisible()
    await doc.getByRole('button', { name: '打开原网页', exact: true }).click()
    await expect(doc).toHaveURL(url => decodeURI(url.href) === decodeURI(pathToFileURL(path).href))
    await expect(doc.locator('body > pre')).toBeVisible()
    await expect(doc.locator('body > pre')).toContainText('来自本地文件夹的正文')
    return
  }
  await expect(doc.getByRole('heading', { name: '原生拖放标题', exact: true })).toBeVisible()
  expect(decodeURI(new URL(doc.url()).searchParams.get('url')!)).toBe(decodeURI(pathToFileURL(path).href))
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toHaveAttribute('contenteditable', 'false')
  await expect(doc.getByRole('button', { name: /打开本地|打开文件夹|导出 Markdown/ })).toHaveCount(0)
  await doc.reload()
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('来自本地文件夹的正文')
  await doc.getByRole('button', { name: '本地目录', exact: true }).click()
  await expect(doc.getByRole('button', { name: '打开 原生 拖入 #100%.markdown', exact: true })).toHaveAttribute('aria-current', 'page')
  expect(await readFile(path, 'utf8')).toBe('# 原生拖放标题\n\n来自本地文件夹的正文')
})

test('拖入非 md 文件不拦截报错，放行给浏览器或页面触发原有逻辑', async () => {
  const { page } = await openClient(undefined, true)
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()

  // 模拟拖入非 Markdown 文件（如 txt、png 等）
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['hello world'], 'demo.txt', { type: 'text/plain' }))
    document.querySelector('main, .workbench')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })

  // 不应触发 "请拖入 .md 或 .markdown 文件" 错误提示
  await page.waitForTimeout(300)
  await expect(page.getByRole('status').filter({ hasText: /请拖入/ })).toHaveCount(0)
  await expect(page.getByText('请拖入 .md 或 .markdown 文件')).toHaveCount(0)
  await expect(page.getByText('文件打开失败')).toHaveCount(0)
})

test('首次拖入主动申请写入权限，随后直接编辑写回并处理磁盘冲突', async () => {
  const { page, context } = await openClient(undefined, true)
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()
  await page.evaluate(() => {
    Object.assign(FileSystemFileHandle.prototype, { requestPermission: async (options: { mode: string }) => {
      localStorage.setItem('dropPermission', options.mode); return 'granted'
    } })
  })
  const doc = await dropLocalFile(page, context, '拖放编辑.md', '拖放前正文')
  expect(await page.evaluate(() => localStorage.getItem('dropPermission'))).toBe('readwrite')
  const body = doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await body.fill('拖放后编辑正文')
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  const disk = () => doc.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('拖放编辑.md')).getFile()).text())
  expect((await disk()).trim()).toBe('拖放后编辑正文')
  await doc.reload()
  await expect(body).toContainText('拖放后编辑正文')
  await doc.evaluate(async () => { const handle = await (await navigator.storage.getDirectory()).getFileHandle('拖放编辑.md'); const writer = await handle.createWritable(); await writer.write('外部修改正文'); await writer.close() })
  await body.fill('保留编辑正文')
  await expect(doc.getByRole('alert')).toContainText('磁盘文件已被其他程序修改')
  expect(await disk()).toBe('外部修改正文')
  await doc.getByRole('button', { name: '保留编辑版本', exact: true }).click()
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
  expect((await disk()).trim()).toBe('保留编辑正文')
})

test('首次拖入拒绝写入授权时保持只读，重新授权后可编辑', async () => {
  const { page, context } = await openClient(undefined, true)
  await context.addInitScript(() => {
    Object.assign(FileSystemFileHandle.prototype, { requestPermission: async () => localStorage.getItem('allowWrite') === 'yes' ? 'granted' : 'denied' })
  })
  await page.reload()
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()
  const doc = await dropLocalFile(page, context, '授权手记.md', '授权前正文')
  const body = doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })
  await expect(body).toHaveAttribute('contenteditable', 'false')
  await expect(doc.getByRole('alert')).toContainText('未获得写入权限')
  await doc.evaluate(() => localStorage.setItem('allowWrite', 'yes'))
  await doc.getByRole('button', { name: '重新授权', exact: true }).click()
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await doc.reload()
  await expect(body).toHaveAttribute('contenteditable', 'true')
  await body.fill('授权后的正文')
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
})

test('本地写入权限失效保留草稿，重开并重新授权后继续保存', async () => {
  const { page, context } = await openClient(undefined, true)
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()
  await context.addInitScript(() => {
    const writable = FileSystemFileHandle.prototype.createWritable
    FileSystemFileHandle.prototype.createWritable = function(options) {
      if (localStorage.getItem('denyWrite') === 'yes') return Promise.reject(new DOMException('文件写入权限失效', 'NotAllowedError'))
      return writable.call(this, options)
    }
    Object.assign(FileSystemFileHandle.prototype, { requestPermission: async () => { localStorage.removeItem('denyWrite'); return 'granted' } })
  })
  const doc = await dropLocalFile(page, context, '权限手记.md', '磁盘原文')
  await doc.evaluate(() => localStorage.setItem('denyWrite', 'yes'))
  await doc.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('保留未保存的草稿')
  await expect(doc.getByRole('alert')).toContainText('文件写入权限失效')
  doc.once('dialog', dialog => void dialog.accept())
  await doc.reload()
  await expect(doc.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('保留未保存的草稿')
  await expect(doc.getByRole('alert')).toContainText('文件写入权限失效')
  await doc.getByRole('button', { name: '重新授权', exact: true }).click()
  await expect(doc.getByRole('status')).toContainText('已保存到原文件')
})

test('拖入非 Markdown 文件时提示支持格式并留在新标签页', async () => {
  const { page, context } = await openClient(undefined, true)
  const originalUrl = page.url(), originalPages = context.pages().length
  await expect(page.getByRole('heading', { name: /我的空间|连接收藏库/, exact: true })).toBeVisible()
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['其他文件'], '其他文件.txt', { type: 'text/plain' }))
    document.querySelector('main')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  await expect(page.getByRole('alert')).toContainText('请拖入 .md 或 .markdown 文件')
  await expect(page).toHaveURL(originalUrl)
  expect(context.pages()).toHaveLength(originalPages)
})

test('本地地址读取失败后可重试读取已恢复的文件', async () => {
  const { page, context, profile } = await openClient(undefined, true)
  const path = join(profile, '稍后恢复.md')
  const doc = await context.newPage()
  const address = new URL('/document/index.html', page.url())
  address.searchParams.set('url', pathToFileURL(path).href)
  await doc.goto(address.href)
  await expect(doc.getByRole('alert')).toBeVisible()
  await writeFile(path, '# 文件已恢复\n\n重新读取的正文')
  await doc.getByRole('button', { name: '重试读取', exact: true }).click()
  await expect(doc.getByRole('heading', { name: '文件已恢复', exact: true })).toBeVisible()
  await expect(doc.getByRole('alert')).toHaveCount(0)
})

test('夸克首次安装直接显示二维码，不依赖运行时新增权限或重新加载', async () => {
  quark.qrPending = true
  const { page } = await openClient(undefined, true)
  await page.evaluate(() => {
    chrome.permissions.request = async () => { throw new Error('首次扫码不应申请新权限') }
  })
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByLabel('夸克登录二维码')).toBeVisible()
  await page.screenshot({ path: 'test-results/connection-quark-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 480, height: 900 })
  const qr = (await page.getByLabel('夸克登录二维码').boundingBox())!
  expect(qr.x).toBeGreaterThanOrEqual(0)
  expect(qr.x + qr.width).toBeLessThanOrEqual(480)
  await expect(page.getByRole('button', { name: '刷新二维码', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/connection-quark-mobile.png', fullPage: true })
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
  await expect(page.getByRole('button', { name: '正在获取二维码…', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '正在获取二维码…', exact: true })).toHaveCSS('opacity', '0.5')
  await page.clock.runFor(31_000)
  await expect(page.getByRole('alert')).toContainText('二维码请求超时')
  await page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(page.getByLabel('夸克登录二维码')).toBeVisible()
})

test('夸克扫码后签名上传并轮换 Cookie，重开和另一设备读取收藏', async () => {
  quark.loginRedirect = true
  quark.qrPending = true
  const first = await openClient(undefined, true)
  await expect(first.page).toHaveTitle('页墟 · 新标签页')
  await expect(first.page.getByText(/^页墟\s*PAGE GARDEN$/)).toBeVisible()
  expect(await first.page.evaluate(() => chrome.runtime.getManifest().name)).toBe('页墟 · Page Garden')
  await expect(first.page.getByRole('button', { name: '扫码登录夸克', exact: true })).toBeVisible()
  await first.page.getByRole('button', { name: '扫码登录夸克', exact: true }).click()
  await expect(first.page.getByLabel('夸克登录二维码')).toBeVisible()
  await first.page.screenshot({ path: test.info().outputPath('quark-login.png') })
  quark.qrPending = false
  await expect(first.page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
  await addLink(first.page, '夸克里的 React')
  await sync(first.page)
  const current = quark.published()
  expect(current).toHaveLength(1)
  expect([...quark.files.values()].filter(file => file.parent === '0').map(file => file.name)).toEqual(['页墟收藏'])
  expect(current[0].body).toContain('夸克里的 React')
  expect(current[0].body).not.toMatch(/__puus|qr_seed/)
  expect(quark.snapshots()).toHaveLength(0)
  expect(quark.published()).toHaveLength(1)
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
  const previous = quark.published().map(file => file.fid)
  const deletedBefore = quark.deleted
  quark.failUpload = true
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(page, '稍后上传的收藏')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('同步未完成')
  for (const fid of previous) expect(quark.files.has(fid)).toBe(true)
  expect(quark.deleted).toBe(deletedBefore)
  await page.reload()
  await expect(page.getByRole('link', { name: '稍后上传的收藏', exact: true })).toBeVisible()
  quark.failUpload = false
  await sync(page)
  expect(quark.published()[0].body).toContain('稍后上传的收藏')
  expect(quark.snapshots()).toHaveLength(0)
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
  await expect(page.getByRole('alert')).toContainText('请重新扫码')
  await page.reload()
  await expect(page.getByRole('link', { name: '登录失效仍保留', exact: true })).toBeVisible()
  quark.expired = false
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true }).click()
  await expect(page.getByText('扫码已完成', { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true })).toBeVisible()
  await sync(page)
})

test('夸克两设备离线新增按顺序同步，自动合并且只保留当前文件', async () => {
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await addLink(first.page, '共同收藏')
  await sync(first.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await Promise.all([first.context.setOffline(true), second.context.setOffline(true)])
  await Promise.all([addLink(first.page, '设备一收藏'), addLink(second.page, '设备二收藏')])
  await first.context.setOffline(false)
  await sync(first.page)
  await second.context.setOffline(false)
  await sync(second.page)
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '设备二收藏', exact: true })).toBeVisible()
  await sync(second.page)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(second.page.getByRole('link', { name: '设备一收藏', exact: true })).toBeVisible()
  expect(quark.published()).toHaveLength(1)
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
  expect(quark.published('other')).toHaveLength(1)
  expect(quark.published('other')[0].body).not.toContain('Rain 的收藏')
  quark.nextAccount = 'rain'
  await page.getByRole('button', { name: '重新扫码 / 切换账号', exact: true }).click()
  await expect(page.getByText('当前夸克账号：rain')).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Rain 的收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Other 的收藏', exact: true })).toHaveCount(0)
})

test('夸克两设备离线编辑同一收藏，顺序同步时保留冲突选择', async () => {
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await addLink(first.page, '需要合并的收藏')
  await sync(first.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await sync(second.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await Promise.all([first.context.setOffline(true), second.context.setOffline(true)])
  await Promise.all([renameLink(first.page, '需要合并的收藏', '设备一的标题'), renameLink(second.page, '需要合并的收藏', '设备二的标题')])
  await first.context.setOffline(false)
  await sync(first.page)
  await second.context.setOffline(false)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await second.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(second.page.getByRole('button', { name: '立即同步', exact: true })).toBeEnabled()
  await expect(second.page.getByRole('status').first()).toHaveText('有冲突待处理')
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toBeVisible()
  await expect(second.page.getByText('设备一的标题', { exact: true }).first()).toBeVisible()
  await expect(second.page.getByText('设备二的标题', { exact: true }).first()).toBeVisible()
  expect(quark.published()[0].body).toContain('设备一的标题')
  const choices = second.page.getByRole('button', { name: '保留本地版本', exact: true })
  for (let remaining = await choices.count(); remaining > 0; remaining--) {
    await choices.first().click()
    await expect(choices).toHaveCount(remaining - 1)
  }
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toHaveCount(0)
  await sync(second.page)
  await sync(second.page)
  await expect(second.page.getByRole('heading', { name: '选择要保留的版本', exact: true })).toHaveCount(0)
  expect(quark.published()).toHaveLength(1)
  expect(quark.published()[0].body).toContain('设备二的标题')
  expect(quark.published()[0].body).not.toContain('设备一的标题')
  expect(quark.snapshots()).toHaveLength(0)
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '设备二的标题', exact: true })).toBeVisible()
})

test('夸克远端损坏时不上传空数据，修正后恢复保存', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, '原始收藏')
  await sync(page)
  const current = quark.published()[0]
  const deletedBefore = quark.deleted
  quark.downloadsCorrupt = true
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('已损坏')
  expect(quark.published()).toEqual([current])
  expect(quark.deleted).toBe(deletedBefore)
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
  for (const file of quark.published()) if (file.body.includes('目录延迟也不能丢的收藏')) quark.hiddenVersions.add(file.fid)
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText(/尚未|移除/)
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

test('打开页面先显示本地收藏，后台快照延迟时仍可使用并随后刷新', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '本地先显示的收藏')
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (request: unknown) => Promise<unknown>
    const pending: (() => void)[] = []
    let released = false
    Object.assign(window, {
      releaseSnapshots() { released = true; for (const release of pending.splice(0)) release() },
      pendingSnapshots: () => pending.length,
    })
    chrome.runtime.sendMessage = ((request: { type?: string }) => {
      if (!released && request?.type === 'snapshot') {
        return new Promise<unknown>(resolve => pending.push(() => resolve(send(request))))
      }
      return send(request)
    }) as typeof chrome.runtime.sendMessage
  })
  await page.reload()
  await expect(page.getByRole('link', { name: '本地先显示的收藏', exact: true })).toBeVisible()
  await expect(page.getByText('正在加载…', { exact: true })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => (window as unknown as DeferredSnapshotWindow).pendingSnapshots())).toBeGreaterThan(0)
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('heading', { name: 'Todo', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: '本地先显示的收藏', exact: true })).toBeVisible()
  // Simulate a change from another page while the background refresh is delayed.
  await page.evaluate(async () => {
    const stored = await chrome.storage.local.get('new-page.workspace.v1')
    const root = stored['new-page.workspace.v1'] as StoredWorkspace
    const link = Object.values(root.sources[root.active!].doc.entities).find(entity => entity.title === '本地先显示的收藏')!
    const result = await chrome.runtime.sendMessage({ type: 'action', sourceId: root.active, action: { type: 'edit', id: link.id, patch: { title: '后台更新后的收藏' } } })
    if (!result.ok) throw new Error(result.error)
    ;(window as unknown as DeferredSnapshotWindow).releaseSnapshots()
  })
  await expect(page.getByRole('link', { name: '后台更新后的收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: '本地先显示的收藏', exact: true })).toHaveCount(0)
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
  await createSpace(page, '工作')
  await page.getByRole('button', { name: '工作', exact: true }).click()
  await createCollection(page, '开发参考')
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

async function drag(page: Page, source: Locator, target: Locator, onHover?: () => Promise<void>) {
  await expect(page.locator('dialog')).toHaveCount(0)
  await source.scrollIntoViewIfNeeded()
  const from = (await source.boundingBox())!
  await target.scrollIntoViewIfNeeded()
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + Math.min(from.width / 2, 80), from.y + Math.min(from.height / 2, 36))
  await page.mouse.down()
  await page.mouse.move(from.x + 14, from.y + 12, { steps: 5 })
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 16 })
  await onHover?.()
  const frames = page.evaluate(async () => {
    const jumps: { distance: number; size: number }[] = []
    let lastAnimated: DOMRect | undefined
    const start = performance.now()
    while (performance.now() - start < 2000) {
      const preview = document.querySelector<HTMLElement>('.drag-preview')
      if (!preview) break
      const overlay = preview.parentElement!
      if (getComputedStyle(overlay).opacity !== '0') {
        const rect = preview.getBoundingClientRect()
        if (overlay.getAnimations({ subtree: true }).length) lastAnimated = rect
        else if (lastAnimated) jumps.push({ distance: Math.hypot(rect.x - lastAnimated.x, rect.y - lastAnimated.y), size: Math.max(Math.abs(rect.width - lastAnimated.width), Math.abs(rect.height - lastAnimated.height)) })
      }
      await new Promise(requestAnimationFrame)
    }
    return jumps.filter(frame => frame.distance > 5 || frame.size > 5)
  })
  await page.mouse.up()
  expect(await frames, '松手动画结束后，复制体不能闪回松手位置或原尺寸').toEqual([])
  await expect(page.locator('.drag-preview')).toHaveCount(0)
}

async function holdAtEdge(page: Page, source: Locator, collection: Locator, edge: 'before' | 'after' = 'after') {
  await expect(page.locator('dialog')).toHaveCount(0)
  await page.bringToFront()
  const from = (await source.boundingBox())!
  const block = (await collection.boundingBox())!
  await page.mouse.move(from.x + Math.min(60, from.width / 2), from.y + 25)
  await page.mouse.down()
  await page.mouse.move(block.x + 90, edge === 'before' ? block.y - 12 : block.y + block.height + 12, { steps: 20 })
}

async function recordMotion(page: Page) {
  return page.evaluateHandle(() => {
    const state = { running: true, frames: [] as { opacity?: number; backdrop?: number; height?: number; x?: number; y?: number }[] }
    const sample = () => {
      if (!state.running) return
      const dialog = document.querySelector('dialog[open]')
      const preview = document.querySelector('.drag-preview')
      const card = document.querySelector('article[aria-label="链接 目标首项"]')
      const rect = card?.getBoundingClientRect()
      state.frames.push({ opacity: dialog ? Number(getComputedStyle(dialog).opacity) : undefined, backdrop: dialog ? Number(getComputedStyle(dialog, '::backdrop').opacity) : undefined, height: preview?.getBoundingClientRect().height, x: rect?.x, y: rect?.y })
      requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    return state
  })
}

test('弹窗进入退出平滑，窄窗口和快速重开保持焦点与内容', async () => {
  const { page } = await openClient()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await connect(page)
  for (const width of [1500, 480]) {
    await page.setViewportSize({ width, height: 900 })
    const launch = page.getByRole('button', { name: '搜索收藏', exact: true })
    const opening = await recordMotion(page)
    await launch.click()
    await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1')
    const entering = await opening.evaluate(state => { state.running = false; return state.frames })
    await opening.dispose()
    expect(entering.some(frame => (frame.opacity ?? 0) > .02 && (frame.opacity ?? 1) < .98), '弹窗进入需要可见的中间状态').toBe(true)
    expect(entering.some(frame => (frame.backdrop ?? 0) > .02 && (frame.backdrop ?? 1) < .98), '遮罩也应平滑出现').toBe(true)
    await expect(page.getByRole('dialog').getByRole('searchbox')).toBeFocused()
    await page.screenshot({ path: test.info().outputPath(`modal-${width}.png`) })
    const closing = await recordMotion(page)
    if (width === 1500) await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
    else await page.keyboard.press('Escape')
    await expect(page.locator('dialog')).toHaveCount(0)
    const exiting = await closing.evaluate(state => { state.running = false; return state.frames })
    await closing.dispose()
    expect(exiting.some(frame => (frame.opacity ?? 0) > .02 && (frame.opacity ?? 1) < .98), '关闭时先播放退出动画再卸载').toBe(true)
    await expect(launch).toBeFocused()
  }
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '搜索收藏', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await page.getByRole('dialog').getByRole('searchbox').fill('快速重开后搜索')
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog')).toHaveCount(0)
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await page.mouse.click(2, 2)
  await expect(page.locator('dialog')).toHaveCount(0)
})

test('待选预览双向变形连续，插入时卡片让位，取消后布局恢复', async () => {
  const { page, context } = await openClient()
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await connect(page)
  await addLink(page, '目标首项')
  await addLink(page, '目标末项')
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/guide`)
  await page.bringToFront()
  const source = page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true })
  const from = (await source.boundingBox())!
  const first = page.getByRole('article', { name: '链接 目标首项', exact: true })
  const firstRect = (await first.boundingBox())!
  const main = (await page.getByRole('main').boundingBox())!
  await page.mouse.move(from.x + 60, from.y + 25)
  await page.mouse.down()
  await page.mouse.move(from.x - 12, from.y + 25)
  await expect(page.locator('.drag-preview')).toBeVisible()
  await expect(page.getByText('停留新建收藏块', { exact: true })).toHaveCount(0)
  const sample = async (recorder: Awaited<ReturnType<typeof recordMotion>>) => {
    await page.waitForTimeout(300)
    const result = await recorder.evaluate(state => { state.running = false; return state.frames })
    await recorder.dispose()
    return result.filter((frame): frame is { height: number; x: number; y: number } => frame.height !== undefined && frame.x !== undefined && frame.y !== undefined)
  }
  const intoMain = await recordMotion(page)
  await page.mouse.move(main.x + 90, main.y + 50)
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())!.height).toBeGreaterThanOrEqual(firstRect.height)
  expect((await sample(intoMain)).some(frame => frame.height > from.height + 3 && frame.height < firstRect.height - 3), '条目变卡片应经过中间尺寸').toBe(true)
  const intoSlot = await recordMotion(page)
  await page.mouse.move(firstRect.x + 35, firstRect.y + 35)
  await expect(page.getByRole('img', { name: '收藏放置位置' })).toBeVisible()
  const gap = await first.evaluate(node => parseFloat(getComputedStyle(node.parentElement!).columnGap))
  await expect.poll(async () => Math.abs((await first.boundingBox())!.x - firstRect.x - firstRect.width - gap)).toBeLessThan(2)
  const insertion = await sample(intoSlot)
  const end = insertion.at(-1)!
  expect(insertion.some(frame => Math.hypot(frame.x - firstRect.x, frame.y - firstRect.y) > 3 && Math.hypot(frame.x - end.x, frame.y - end.y) > 3), '相邻卡片需要经过中间位置让位').toBe(true)
  await page.screenshot({ path: test.info().outputPath('insertion-layout.png') })
  const out = await recordMotion(page)
  await page.mouse.move(from.x + 50, from.y + 25)
  await expect.poll(async () => Math.abs((await page.locator('.drag-preview').boundingBox())!.height - from.height)).toBeLessThan(2)
  expect((await sample(out)).some(frame => frame.height > from.height + 3 && frame.height < firstRect.height - 3), '离开中间区域也应连续变回条目').toBe(true)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  expect(tab.isClosed()).toBe(false)
  await expect.poll(async () => Math.abs((await first.boundingBox())!.x - firstRect.x)).toBeLessThan(2)
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('link')).toHaveText(['目标首项', '目标末项'])
})

test('减少动态效果时快捷建块立即提示松手创建', async () => {
  const { page, context } = await openClient()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await connect(page)
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCSS('opacity', '1')
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog')).toHaveCount(0)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/guide`)
  await holdAtEdge(page, page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }))
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 1000 })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '收藏块 新收藏', exact: true }).getByRole('link')).toHaveText('UnoCSS 指南')
  await expect(page.locator('.drag-preview')).toHaveCount(0)
})

test('收藏卡片移除旧移动图标，空备注不保留多余底部高度', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '紧凑收藏')
  const card = page.getByRole('article', { name: '链接 紧凑收藏', exact: true })
  const edit = card.getByRole('button', { name: '编辑链接', exact: true })
  const todo = card.getByRole('button', { name: '加入 Todo', exact: true })
  const settings = page.getByRole('button', { name: '设置', exact: true })
  await settings.hover()
  await settings.focus()
  await expect(edit).toHaveCSS('opacity', '0')
  await card.focus()
  await expect(edit).toHaveCSS('opacity', '1')
  await expect(todo).toHaveCSS('opacity', '1')
  await todo.click()
  await settings.hover()
  await settings.focus()
  await expect(edit).toHaveCSS('opacity', '0')
  await expect(card.getByRole('button', { name: '移出 Todo', exact: true })).toHaveCSS('opacity', '1')
  await card.hover()
  await expect(card.getByRole('button', { name: '移动链接', exact: true })).toHaveCount(0)
  expect((await card.boundingBox())!.height).toBeLessThan(145)
  await page.setViewportSize({ width: 480, height: 900 })
  await settings.hover()
  await settings.focus()
  await expect(edit).toHaveCSS('opacity', '1')
  await page.screenshot({ path: 'test-results/card-mobile-actions.png', fullPage: true })
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
  await expect(preview.getByText('react.dev', { exact: true })).toHaveCount(0)
  const floating = (await preview.boundingBox())!
  expect(Math.abs(floating.width - source.width)).toBeLessThan(2)
  expect(Math.abs(floating.height - source.height)).toBeLessThan(2)
  await expect(card.getByText('拖动时这段备注也完整保留', { exact: true })).not.toBeVisible()
  await expect.poll(async () => Math.abs((await card.boundingBox())!.x - target.x)).toBeLessThan(3)
  await page.screenshot({ path: 'test-results/card-drag-placeholder.png', fullPage: true })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '收藏块 日常收藏' }).getByRole('link')).toHaveText(['目标卡片', '保留内容的卡片'])
})

test('待选网页收藏成功后只关闭被拖动的原标签页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const original = await context.newPage()
  await original.goto(`${origin}/web/react`)
  const duplicate = await context.newPage()
  await duplicate.goto(`${origin}/web/react`)
  await page.bringToFront()
  await expect(page.getByRole('article', { name: '待选 React 文档', exact: true })).toHaveCount(2)
  await drag(page, page.getByRole('article', { name: '待选 React 文档', exact: true }).first(), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }))
  await expect.poll(() => original.isClosed()).toBe(true)
  expect(duplicate.isClosed()).toBe(false)
  await expect(page.getByRole('article', { name: '待选 React 文档', exact: true })).toHaveCount(1)
  await page.reload()
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
})

test('待选网页进入整个中间区域即变卡片并按占位顺序插入', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '已有首项')
  await addLink(page, '已有末项')
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/guide`)
  await page.bringToFront()
  const source = (await page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }).boundingBox())!
  const main = (await page.getByRole('main').boundingBox())!
  await page.mouse.move(source.x + 60, source.y + 25)
  await page.mouse.down()
  await page.mouse.move(main.x + 90, main.y + 50, { steps: 20 })
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(124)
  const target = (await page.getByRole('article', { name: '链接 已有末项', exact: true }).boundingBox())!
  await page.mouse.move(target.x + 40, target.y + 45, { steps: 20 })
  await expect(page.getByRole('img', { name: '收藏放置位置' })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('link')).toHaveText(['已有首项', 'UnoCSS 指南', '已有末项'])
  await expect.poll(() => tab.isClosed()).toBe(true)
  await page.reload()
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('link')).toHaveText(['已有首项', 'UnoCSS 指南', '已有末项'])
})

test('待选网页拖入先显示卡片占位，松手后平滑落位', async () => {
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
  const placeholder = page.getByRole('img', { name: '收藏放置位置' })
  await expect(placeholder).toBeVisible()
  expect(Math.abs((await collection.boundingBox())!.height - target.height), '空收藏块进入拖拽占位时不能改变高度').toBeLessThan(3)
  expect(Math.abs((await preview.boundingBox())!.height - (await placeholder.boundingBox())!.height)).toBeLessThan(2)
  await page.screenshot({ path: 'test-results/inbox-drop-placeholder.png', fullPage: true })
  const frames = page.evaluate(async () => {
    const heights: { floating: number; saved: number; distance: number }[] = []
    const start = performance.now()
    while (performance.now() - start < 1200) {
      const preview = document.querySelector<HTMLElement>('.drag-preview')
      const floating = preview && getComputedStyle(preview.parentElement!).opacity !== '0' ? preview.getBoundingClientRect() : undefined
      const saved = document.querySelector('article[aria-label="链接 React 文档"]')?.getBoundingClientRect()
      if (floating && saved) heights.push({ floating: floating.height, saved: saved.height, distance: Math.hypot(floating.x - saved.x, floating.y - saved.y) })
      await new Promise(requestAnimationFrame)
    }
    return heights
  })
  await page.mouse.up()
  const card = page.getByRole('article', { name: '链接 React 文档', exact: true })
  const dropFrames = await frames
  const arrived = dropFrames.findIndex(frame => frame.distance < 3 && Math.abs(frame.floating - frame.saved) < 3)
  expect(arrived, '预览应平滑到达收藏卡片的位置和尺寸').toBeGreaterThanOrEqual(0)
  expect(dropFrames.slice(arrived).filter(frame => frame.distance > 5 || Math.abs(frame.floating - frame.saved) > 5), '落位后直到移除预览都不能闪回松手位置或原尺寸').toEqual([])
  await expect(preview).toHaveCount(0)
  await expect(card).toBeVisible()
  expect(Math.abs((await collection.boundingBox())!.height - target.height), '首条收藏落位后应保持同样的高度').toBeLessThan(3)
  await expect(collection.getByRole('link')).toHaveCount(1)
  await expect.poll(() => tab.isClosed()).toBe(true)
})

test('已有收藏链接到达块间落点即松手，立即原子建立新收藏', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '快捷移动的链接')
  const moving = page.getByRole('article', { name: '链接 快捷移动的链接', exact: true })
  await moving.hover()
  await moving.getByRole('button', { name: '编辑链接', exact: true }).click()
  await page.getByRole('dialog').getByLabel('备注', { exact: true }).fill('移动后保留的备注')
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(moving.getByText('移动后保留的备注', { exact: true })).toBeVisible()
  await moving.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await createCollection(page, '下方收藏块')
  await expect(page.locator('dialog')).toHaveCount(0)
  const original = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const from = (await original.getByRole('article').boundingBox())!
  const block = (await original.boundingBox())!
  await page.mouse.move(from.x + 60, from.y + 30)
  await page.mouse.down()
  await page.mouse.move(block.x + 90, block.y + block.height + 12, { steps: 20 })
  await expect(page.getByRole('status', { name: '快捷建块位置' })).toBeVisible()
  expect(await page.getByText('停留新建收藏块', { exact: true }).count()).toBe(0)
  await page.mouse.up()
  const created = page.getByRole('region', { name: '收藏块 新收藏', exact: true })
  await expect(created.getByRole('link')).toHaveText('快捷移动的链接')
  await expect(created.getByText('移动后保留的备注', { exact: true })).toBeVisible()
  await expect(created.getByRole('button', { name: '移出 Todo', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(original.getByRole('article')).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['日常收藏0', '新收藏1', '下方收藏块0'])
  await page.reload()
  await expect(created.getByRole('link')).toHaveText('快捷移动的链接')
})

test('待选网页在首尾快捷建块，本地保存后关闭原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const original = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  for (const edge of ['before', 'after']) {
    if (edge === 'after') {
      await page.setViewportSize({ width: 820, height: 900 })
      await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
    }
    const tab = await context.newPage()
    await tab.goto(`${origin}/web/react`)
    await page.bringToFront()
    const block = (await original.boundingBox())!
    const source = (await page.getByRole('article', { name: '待选 React 文档', exact: true }).boundingBox())!
    await page.mouse.move(source.x + 60, source.y + 25)
    await page.mouse.down()
    await page.mouse.move(block.x + 90, edge === 'before' ? block.y - 12 : block.y + block.height + 12, { steps: 20 })
    await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
    if (edge === 'after') await page.screenshot({ path: 'test-results/quick-collection-narrow.png', fullPage: true })
    await page.mouse.up()
    await expect.poll(() => tab.isClosed()).toBe(true)
  }
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['新收藏1', '日常收藏0', '新收藏1'])
  await page.reload()
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toHaveCount(2)
})

test('快捷建块切换落点后松手立即创建，取消仍不收集', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const source = page.getByRole('article', { name: '待选 React 文档', exact: true })
  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await holdAtEdge(page, source, collection)
  await expect(page.getByRole('status', { name: '快捷建块位置' })).toBeVisible()
  const block = (await collection.boundingBox())!
  await page.mouse.move(block.x + 90, block.y - 12, { steps: 10 })
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '收藏块 新收藏', exact: true })).toHaveCount(0)
  expect(tab.isClosed()).toBe(false)
  await holdAtEdge(page, source, collection)
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  await page.mouse.move(block.x + 90, block.y - 12, { steps: 10 })
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible()
  await page.mouse.up()
  await expect(page.getByRole('status', { name: '快捷建块位置' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['新收藏1', '日常收藏0'])
  await expect.poll(() => tab.isClosed()).toBe(true)
})

test('快捷建块本地保存不等待夸克，重启后同步到另一客户端', async () => {
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  quark.failUpload = true
  const tab = await first.context.newPage()
  await tab.goto(`${origin}/web/react`)
  await holdAtEdge(first.page, first.page.getByRole('article', { name: '待选 React 文档', exact: true }), first.page.getByRole('region', { name: '收藏块 日常收藏', exact: true }), 'before')
  await expect(first.page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  await first.page.mouse.up()
  await expect.poll(() => tab.isClosed()).toBe(true)
  await expect(first.page.getByRole('region', { name: '收藏块 新收藏', exact: true }).getByRole('link')).toHaveText('React 文档')
  await first.page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(first.page.getByRole('status').first()).toContainText('同步未完成')
  await first.context.close()
  clients.splice(clients.findIndex(client => client.profile === first.profile), 1)
  const restarted = await openClient(first.profile, true)
  await expect(restarted.page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['新收藏1', '日常收藏0'])
  quark.failUpload = false
  await sync(restarted.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await expect(second.page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['新收藏1', '日常收藏0'])
  await expect(second.page.getByRole('region', { name: '收藏块 新收藏', exact: true }).getByRole('link')).toHaveText('React 文档')
})

test('键盘收集待选网页并在卡片之间排序', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  await page.getByRole('article', { name: '待选 React 文档', exact: true }).focus()
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('img', { name: '收藏放置位置' })).toBeVisible()
  await page.keyboard.press('Space', { delay: 100 })
  await expect.poll(() => tab.isClosed()).toBe(true)
  await addLink(page, '排到前面的卡片')
  await page.getByRole('article', { name: '链接 排到前面的卡片', exact: true }).focus()
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  const startX = (await page.locator('.drag-preview').boundingBox())!.x
  await page.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())!.x).toBeLessThan(startX)
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('link')).toHaveText(['排到前面的卡片', 'React 文档'])
})

test('滚动离开快捷建块落点后清除提示且不创建', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '滚动时保留原位置')
  for (const title of ['下面一块', '下面二块', '下面三块', '下面四块']) {
    await createCollection(page, title)
  }
  const original = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const block = (await original.boundingBox())!
  await holdAtEdge(page, original.getByRole('article'), original)
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  await page.getByRole('region', { name: '页面内容', exact: true }).evaluate(element => element.scrollBy(0, 100))
  await expect(page.getByText('松手新建收藏块', { exact: true })).toHaveCount(0)
  await page.waitForTimeout(2100)
  await expect(page.getByRole('status', { name: '快捷建块位置' })).toHaveCount(0)
  await page.mouse.move(block.x + 90, block.y - 12 - 100, { steps: 10 })
  await page.waitForTimeout(2100)
  await expect(page.getByRole('status', { name: '快捷建块位置' })).toHaveCount(0)
  await page.mouse.up()
  await expect(page.getByRole('region', { name: '收藏块 新收藏', exact: true })).toHaveCount(0)
})

test('快捷建块本地保存失败不留下空块也不关闭原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  await holdAtEdge(page, page.getByRole('article', { name: '待选 React 文档', exact: true }), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }))
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  const worker = context.serviceWorkers()[0]
  await worker.evaluate(() => {
    const original = chrome.storage.local.set
    chrome.storage.local.set = async () => { chrome.storage.local.set = original; throw new Error('受控本地保存失败') }
  })
  await page.mouse.up()
  await expect(page.getByRole('alert')).toContainText('受控本地保存失败')
  await expect(page.getByRole('region', { name: '收藏块 新收藏', exact: true })).toHaveCount(0)
  expect(tab.isClosed()).toBe(false)
  await page.reload()
  await expect(page.getByRole('region', { name: /^收藏块/ })).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toHaveCount(0)
})

for (const changed of ['跳转', '关闭'] as const) test(`原标签页拖动期间${changed}，收集使用开始时的网页`, async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const source = page.getByRole('article', { name: '待选 React 文档', exact: true })
  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await holdAtEdge(page, source, collection)
  if (changed === '跳转') await tab.goto(`${origin}/web/guide`)
  else await tab.close()
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  await page.mouse.up()
  const saved = page.getByRole('region', { name: '收藏块 新收藏', exact: true }).getByRole('link', { name: 'React 文档', exact: true })
  await expect(saved).toHaveAttribute('href', `${origin}/web/react`)
  if (changed === '跳转') {
    expect(tab.isClosed()).toBe(false)
    await expect(page.getByRole('alert')).toContainText('原标签页已变化')
  } else await expect(page.getByRole('alert')).toHaveCount(0)
})

test('置顶标签页收集后关闭，关闭失败时保留收藏并提示', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const pinned = await context.newPage()
  await pinned.goto(`${origin}/web/react`)
  await page.evaluate(async url => { const [tab] = await chrome.tabs.query({ url }); await chrome.tabs.update(tab.id!, { pinned: true }) }, pinned.url())
  await drag(page, page.getByRole('article', { name: '待选 React 文档', exact: true }), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }))
  await expect.poll(() => pinned.isClosed()).toBe(true)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/guide`)
  await page.evaluate(() => { chrome.tabs.remove = async () => { throw new Error('受控关闭失败') } })
  await drag(page, page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }))
  await expect(page.getByRole('link', { name: 'UnoCSS 指南', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('无法关闭原标签页')
  expect(tab.isClosed()).toBe(false)
})

for (const input of ['键盘', '触摸'] as const) test(`${input}到达快捷落点后可立即放下建立收藏块`, async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '通过不同输入移动')
  const card = page.getByRole('article', { name: '链接 通过不同输入移动', exact: true })
  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const session = input === '触摸' ? await context.newCDPSession(page) : null
  if (session) {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    const from = (await card.boundingBox())!
    const block = (await collection.boundingBox())!
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x + 60, y: from.y + 30 }] })
    await page.waitForTimeout(240)
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: block.x + 90, y: block.y - 12 }] })
  } else {
    await card.focus()
    await page.keyboard.press('Space')
    await expect(page.locator('.drag-preview')).toBeVisible()
    await page.keyboard.press('ArrowUp')
  }
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  else await page.keyboard.press('Space')
  await expect(page.getByRole('region', { name: '收藏块 新收藏', exact: true }).getByRole('link')).toHaveText('通过不同输入移动')
})

test('没有收藏块时不提供拖入建块落点', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await createSpace(page, '空空间')
  await page.getByRole('button', { name: '空空间', exact: true }).click()
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const source = (await page.getByRole('article', { name: '待选 React 文档', exact: true }).boundingBox())!
  const empty = (await page.getByRole('heading', { name: '暂无收藏块', exact: true }).boundingBox())!
  await page.mouse.move(source.x + 60, source.y + 25)
  await page.mouse.down()
  await page.mouse.move(empty.x, empty.y, { steps: 20 })
  await page.waitForTimeout(2200)
  await expect(page.getByRole('status', { name: '快捷建块位置' })).toHaveCount(0)
  await page.mouse.up()
  await expect(page.getByRole('region', { name: /^收藏块/ })).toHaveCount(0)
  expect(tab.isClosed()).toBe(false)
})

test('空收藏块下边缘悬停和取消保持高度，下方收藏块不跳动', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await createCollection(page, '下方收藏块')
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const inbox = page.getByRole('article', { name: '待选 React 文档', exact: true })
  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const next = page.getByRole('region', { name: '收藏块 下方收藏块', exact: true })
  for (const width of [1500, 820]) {
    await page.setViewportSize({ width, height: 960 })
    if (width === 820) await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
    const target = (await collection.boundingBox())!
    const nextY = (await next.boundingBox())!.y
    if (width === 1500) await page.screenshot({ path: 'test-results/empty-collection-desktop.png', fullPage: true })
    const source = (await inbox.boundingBox())!
    await page.mouse.move(source.x + 60, source.y + 25)
    await page.mouse.down()
    await page.mouse.move(target.x + 60, target.y + target.height - 14, { steps: 20 })
    await expect(page.getByRole('img', { name: '收藏放置位置' })).toBeVisible()
    const frames = await page.evaluate(async () => {
      const samples: { height: number; nextY: number; placeholders: number }[] = []
      const start = performance.now()
      while (performance.now() - start < 350) {
        samples.push({
          height: document.querySelector('section[aria-label="收藏块 日常收藏"]')!.getBoundingClientRect().height,
          nextY: document.querySelector('section[aria-label="收藏块 下方收藏块"]')!.getBoundingClientRect().y,
          placeholders: document.querySelectorAll('[aria-label="收藏放置位置"]').length,
        })
        await new Promise(requestAnimationFrame)
      }
      return samples
    })
    expect(frames.every(frame => Math.abs(frame.height - target.height) < 3 && Math.abs(frame.nextY - nextY) < 3 && frame.placeholders === 1), `窗口 ${width}px 下，悬停不能反复切换空态和占位或移动下方内容`).toBe(true)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(page.locator('.drag-preview')).toHaveCount(0)
    await expect(page.getByRole('img', { name: '收藏放置位置' })).toHaveCount(0)
    await expect(collection.getByRole('heading', { name: '暂无收藏', exact: true })).toBeVisible()
    expect(Math.abs((await collection.boundingBox())!.height - target.height)).toBeLessThan(3)
    expect(Math.abs((await next.boundingBox())!.y - nextY)).toBeLessThan(3)
  }
  const before = (await next.boundingBox())!.y
  await drag(page, inbox, collection)
  await expect(collection.getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  expect(Math.abs((await next.boundingBox())!.y - before)).toBeLessThan(3)
})

test('收藏块展开和收起动画结束时高度连续', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '高度稳定的收藏')
  await createCollection(page, '下方收藏块')
  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await expect(page.getByRole('region', { name: '收藏块 下方收藏块', exact: true })).toBeVisible()
  for (const label of ['折叠 日常收藏', '展开 日常收藏']) {
    const frames = await page.evaluate(async label => {
      const region = document.querySelector<HTMLElement>('section[aria-label="收藏块 日常收藏"]')!
      const next = document.querySelector<HTMLElement>('section[aria-label="收藏块 下方收藏块"]')!
      region.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')!.click()
      const samples: { height: number; nextY: number; animating: boolean }[] = []
      const start = performance.now()
      while (performance.now() - start < 700) {
        await new Promise(requestAnimationFrame)
        samples.push({
          height: region.getBoundingClientRect().height,
          nextY: next.getBoundingClientRect().y,
          animating: region.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' &&
            (animation.effect as KeyframeEffect | null)?.getKeyframes().some(frame => 'height' in frame)),
        })
      }
      return samples
    }, label)
    const completed = frames.findIndex((frame, index) => index > 0 && frames[index - 1].animating && !frame.animating)
    expect(completed, label + ' 应播放高度动画').toBeGreaterThan(0)
    const jump = Math.abs(frames[completed].height - frames[completed - 1].height)
    expect(jump, label + ' 动画结束时高度跳变 ' + jump.toFixed(1) + 'px').toBeLessThan(3)
    const lateJump = Math.max(...frames.slice(completed + 1).map((frame, index) =>
      Math.abs(frame.nextY - frames[completed + index].nextY)))
    expect(lateJump, label + ' 完成后下方收藏块突然移动 ' + lateJump.toFixed(1) + 'px').toBeLessThan(3)
    await expect(collection.getByRole('button', { name: label.startsWith('折叠') ? '展开 日常收藏' : '折叠 日常收藏', exact: true })).toBeVisible()
  }
})

test('收藏块收起过程中卡片保持渲染并在动画中自然收起，且响应迅速', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '测试卡片')
  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await expect(collection.getByRole('article', { name: '链接 测试卡片' })).toBeVisible()

  const frames = await page.evaluate(async () => {
    const region = document.querySelector<HTMLElement>('section[aria-label="收藏块 日常收藏"]')!
    const collapseBtn = region.querySelector<HTMLButtonElement>('button[aria-label="折叠 日常收藏"]')!
    const samples: { elapsed: number; cardCount: number; height: number; animating: boolean }[] = []
    const start = performance.now()
    collapseBtn.click()
    while (performance.now() - start < 700) {
      await new Promise(requestAnimationFrame)
      const cards = region.querySelectorAll('article')
      const anims = region.getAnimations({ subtree: true })
      const isHeightAnim = anims.some(a => a.playState === 'running' && (a.effect as KeyframeEffect | null)?.getKeyframes().some(f => 'height' in f))
      samples.push({
        elapsed: performance.now() - start,
        cardCount: cards.length,
        height: region.getBoundingClientRect().height,
        animating: isHeightAnim,
      })
    }
    return samples
  })

  const firstAnimFrame = frames.find(f => f.animating)
  expect(firstAnimFrame, '点击折叠后应迅速启动动画').toBeDefined()
  expect(firstAnimFrame!.elapsed, '点击折叠后启动动画不应有明显延迟').toBeLessThan(100)

  const midAnimFrames = frames.filter(f => f.animating)
  expect(midAnimFrames.length, '应有收起动画过程帧').toBeGreaterThan(0)
  for (const frame of midAnimFrames) {
    expect(frame.cardCount, '收起动画执行过程中卡片不应提前消失').toBeGreaterThan(0)
  }
})

test('跨收藏块的落点占位稳定，折叠块取消拖动后保持原状', async () => {
  const { page } = await openClient()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await connect(page)
  await addLink(page, '跨块移动项')
  await createCollection(page, '来源块')
  const destination = page.getByRole('region', { name: '收藏块 日常收藏' })
  const sourceBlock = page.getByRole('region', { name: '收藏块 来源块' })
  await drag(page, destination.getByRole('article'), sourceBlock)
  await addLink(page, '目标首项')
  const sourceCard = sourceBlock.getByRole('article')
  await expect(sourceCard).toHaveCSS('transition-property', 'none')
  const from = (await sourceCard.boundingBox())!
  const target = (await destination.getByRole('article').boundingBox())!
  await page.mouse.move(from.x + 60, from.y + 30)
  await page.mouse.down()
  await page.mouse.move(target.x + 60, target.y + 30, { steps: 20 })
  const marker = page.getByRole('img', { name: '收藏放置位置' })
  await expect(marker).toBeVisible()
  await expect(marker).toHaveCSS('animation-name', 'none')
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
    await addLink(page, title, `${origin}/web/react`)
    const card = page.getByRole('article', { name: `链接 ${title}`, exact: true })
    await card.hover()
    await card.getByRole('button', { name: '加入 Todo', exact: true }).click()
  }
  await createSpace(page, '另一个空间')
  await page.getByRole('button', { name: '另一个空间', exact: true }).click()
  await createCollection(page, '参考')
  await addLink(page, '跨空间待办', `${origin}/web/react`)
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
  await expect(openedPage).toHaveURL(`${origin}/web/react`)
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

test('日常收藏支持拖入并保留一键收藏入口，空备注留空', async () => {
  const { page, context } = await openClient()
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const guide = await context.newPage()
  await guide.goto(`${origin}/web/guide`)
  await connect(page)
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(page.getByRole('button', { name: /添加链接|添加第一个链接|收藏当前窗口/ })).toHaveCount(0)
  await expect(inbox.getByRole('button', { name: '一键收藏', exact: true })).toBeVisible()
  await expect(inbox.getByText('React 文档', { exact: true })).toBeVisible()
  await drag(page, inbox.getByRole('article', { name: '待选 React 文档' }), page.getByRole('region', { name: '收藏块 日常收藏' }))
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('还没有备注', { exact: true })).toHaveCount(0)
  await expect(page.getByText('改动自动保存', { exact: true })).toHaveCount(0)
  await expect(page.getByText('一点点收集，一点点生长', { exact: true })).toHaveCount(0)
  await expect.poll(() => tab.isClosed()).toBe(true)
  await createCollection(page, '稍后阅读')
  await page.getByRole('button', { name: '折叠 稍后阅读', exact: true }).click()
  await drag(page, page.getByRole('article', { name: '链接 React 文档', exact: true }), page.getByRole('region', { name: '收藏块 稍后阅读' }))
  await expect(page.getByRole('region', { name: '收藏块 稍后阅读' }).getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await drag(page, inbox.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), page.getByRole('region', { name: '收藏块 日常收藏' }))
  await expect(page.getByRole('link', { name: 'UnoCSS 指南', exact: true })).toBeVisible()
  await expect.poll(() => guide.isClosed()).toBe(true)
  await page.setViewportSize({ width: 820, height: 900 })
  await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
  await expect(inbox.getByText('UnoCSS 指南', { exact: true })).toHaveCount(0)
  const nextGuide = await context.newPage()
  await nextGuide.goto(`${origin}/web/guide`)
  await expect(inbox.getByText('UnoCSS 指南', { exact: true })).toBeVisible()
  await nextGuide.close()
  await expect(inbox.getByText('UnoCSS 指南', { exact: true })).toHaveCount(0)
})

test('删除收藏块隐藏 Todo，回收站恢复层次与标记，备份不含凭据', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '值得重读')
  await page.getByRole('article').hover()
  await page.getByRole('button', { name: /加入(待办| Todo)/, exact: true }).click()
  await page.getByRole('button', { name: '删除 日常收藏', exact: true }).click()
  await page.screenshot({ path: 'test-results/delete-collection-dialog.png', fullPage: true })
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '值得重读', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('显示昵称').fill('小雨')
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 日常收藏', exact: true }).click()
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
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
  await second.page.screenshot({ path: 'test-results/conflict-desktop.png', fullPage: true })
  await second.page.setViewportSize({ width: 480, height: 900 })
  const localVersion = second.page.getByRole('button', { name: '保留本地版本', exact: true })
  const remoteVersion = second.page.getByRole('button', { name: '保留远端版本', exact: true })
  await localVersion.scrollIntoViewIfNeeded()
  const localBounds = (await localVersion.boundingBox())!
  const remoteBounds = (await remoteVersion.boundingBox())!
  expect(remoteBounds.y).toBeGreaterThan(localBounds.y + localBounds.height)
  expect(remoteBounds.x + remoteBounds.width).toBeLessThanOrEqual(480)
  await second.page.screenshot({ path: 'test-results/conflict-mobile.png', fullPage: true })
  await second.page.setViewportSize({ width: 1500, height: 960 })
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
  await expect(page.locator('[data-fluid-scene] [aria-label="用户 Rain"]')).toBeVisible()
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
  await createCollection(page, '优先阅读')
  await drag(page, page.getByRole('region', { name: '收藏块 优先阅读', exact: true }).getByRole('heading', { level: 2 }), page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('heading', { level: 2 }))
  await expect(page.getByRole('region', { name: /^收藏块/ }).first()).toHaveAccessibleName('收藏块 优先阅读')
  await createSpace(page, '灵感')
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

test('回收站支持确认删除和清空，取消保留内容且同步后仍然生效', async () => {
  test.setTimeout(90_000)
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '单项删除的收藏')
  await addLink(page, '清空的收藏')
  await addLink(page, '保留的收藏')
  for (const title of ['单项删除的收藏', '清空的收藏']) {
    const card = page.getByRole('article', { name: `链接 ${title}`, exact: true })
    await card.hover()
    await card.getByRole('button', { name: '删除链接', exact: true }).click()
    await expect(card).toHaveCount(0)
  }
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  const clear = page.getByRole('button', { name: '清空回收站', exact: true })
  await expect(clear).toBeEnabled()
  const remove = page.getByRole('button', { name: '彻底删除 单项删除的收藏', exact: true })
  await remove.hover()
  await remove.focus()
  await expect(remove).toBeFocused()
  await remove.press('Enter')
  const dialog = page.getByRole('dialog', { name: '彻底删除', exact: true })
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused()
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(remove).toBeVisible()
  await remove.click()
  await dialog.getByRole('button', { name: '删除', exact: true }).click()
  await expect(remove).toHaveCount(0)
  await expect(page.getByRole('button', { name: '恢复 清空的收藏', exact: true })).toBeVisible()
  await page.screenshot({ path: 'test-results/recycle-bin-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 360, height: 800 })
  const bin = page.getByRole('button', { name: '回收站', exact: true })
  const remaining = page.getByRole('button', { name: '彻底删除 清空的收藏', exact: true })
  await remaining.scrollIntoViewIfNeeded()
  const bounds = (await remaining.boundingBox())!
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(360)
  await page.screenshot({ path: 'test-results/recycle-bin-mobile.png', fullPage: true })
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await bin.dblclick()
  const emptyDialog = page.getByRole('dialog', { name: '清空回收站', exact: true })
  await expect(emptyDialog.getByText('删除后无法从回收站恢复。', { exact: true })).toBeVisible()
  await expect(page.getByRole('dialog', { name: '回收站', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(bin).toBeVisible()
  await bin.dblclick()
  await emptyDialog.getByRole('button', { name: '清空', exact: true }).click()
  await bin.click()
  await expect(page.getByText('回收站空空的', { exact: true })).toBeVisible()
  await expect(clear).toBeDisabled()
  await page.setViewportSize({ width: 1500, height: 960 })
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await sync(page)
  const remote = JSON.parse(files.get('/dav/new-page/data-v1.json')!.body) as Document
  const purged = Object.values(remote.entities).filter(entity => entity.purged)
  expect(purged).toHaveLength(2)
  for (const entity of purged) expect(entity).toMatchObject({ title: '', url: '', icon: '', note: '', todo: false })
  await page.reload()
  await bin.click()
  await expect(page.getByText('回收站空空的', { exact: true })).toBeVisible()
  const other = await openClient()
  await connect(other.page)
  await expect(other.page.getByRole('link', { name: '保留的收藏', exact: true })).toBeVisible()
  await other.page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(other.page.getByText('回收站空空的', { exact: true })).toBeVisible()
})

test('拖入侧栏废纸篓立即删除，点击后可恢复', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '拖入废纸篓的链接')
  const bin = page.getByRole('button', { name: '回收站', exact: true })
  await expect(bin).toHaveText('')
  await bin.screenshot({ path: 'test-results/recycle-bin-empty.png' })
  await page.screenshot({ path: 'test-results/recycle-bin-sidebar-empty.png', fullPage: true })
  await drag(page, page.getByRole('article', { name: '链接 拖入废纸篓的链接', exact: true }), bin, async () => {
    await page.screenshot({ path: 'test-results/recycle-bin-drop-hover.png', fullPage: true })
  })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('article', { name: '链接 拖入废纸篓的链接', exact: true })).toHaveCount(0)
  await bin.screenshot({ path: 'test-results/recycle-bin-full.png' })
  await page.screenshot({ path: 'test-results/recycle-bin-sidebar-full.png', fullPage: true })
  await page.setViewportSize({ width: 360, height: 800 })
  await bin.screenshot({ path: 'test-results/recycle-bin-narrow.png' })
  await bin.click()
  await expect(page.getByRole('button', { name: '恢复 拖入废纸篓的链接', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '恢复 拖入废纸篓的链接', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复 拖入废纸篓的链接', exact: true })).toHaveCount(0)
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await page.setViewportSize({ width: 1500, height: 960 })
  await expect(page.getByRole('article', { name: '链接 拖入废纸篓的链接', exact: true })).toBeVisible()
  await drag(page, page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('heading', { level: 2 }), bin)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await bin.click()
  await expect(page.getByRole('button', { name: '恢复 日常收藏', exact: true })).toBeVisible()
})

test('废纸篓关闭拖入的标签页，并拒绝删除唯一空间', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  await page.bringToFront()
  const bin = page.getByRole('button', { name: '回收站', exact: true })
  await drag(page, page.getByRole('article', { name: '待选 React 文档', exact: true }), bin)
  await expect.poll(() => tab.isClosed()).toBe(true)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await drag(page, page.getByRole('button', { name: '我的空间', exact: true }), bin)
  await expect(page.getByRole('button', { name: '我的空间', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
})

test('单篇笔记拖入废纸篓后永久删除', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const editor = await newNote(page, context, '拖入废纸篓的笔记', '正文内容')
  await page.bringToFront()
  const bin = page.getByRole('button', { name: '回收站', exact: true })
  await drag(page, page.getByRole('article', { name: '笔记 拖入废纸篓的笔记', exact: true }), bin)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('article', { name: '笔记 拖入废纸篓的笔记', exact: true })).toHaveCount(0)
  await expect(editor.getByRole('alert')).toContainText('永久删除')
  await bin.click()
  await expect(page.getByRole('button', { name: '恢复 拖入废纸篓的笔记', exact: true })).toHaveCount(0)
})

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
  await expect(first.page.getByRole('link', { name: '会过期的收藏', exact: true })).toHaveCount(0)
  await expect(first.page.getByRole('dialog')).toHaveCount(0)
  await sync(first.page)
  await first.page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(first.page.getByRole('button', { name: '恢复 会过期的收藏', exact: true })).toBeVisible()
  // Advance the deletion time through the controlled WebDAV boundary, not private extension state.
  const path = '/dav/new-page/data-v1.json'
  const remote = files.get(path)!
  const backup = JSON.parse(remote.body)
  for (const entity of Object.values(backup.entities) as { deletedAt: number | null; updatedAt: number }[]) {
    if (entity.deletedAt !== null) { entity.deletedAt = Date.now() - 31 * 86400_000; entity.updatedAt = entity.deletedAt }
  }
  files.set(path, { body: JSON.stringify(backup), revision: remote.revision + 1 })
  await first.page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await sync(first.page)
  await first.page.getByRole('button', { name: '回收站', exact: true }).click()
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
  await expect(page.locator('html')).toHaveCSS('font-size', '14px')
  await expect(page.locator('html')).toHaveCSS('line-height', '21px')
  expect(await page.evaluate(() => {
    const context = document.createElement('canvas').getContext('2d')!
    context.fillStyle = getComputedStyle(document.documentElement).backgroundColor
    context.fillRect(0, 0, 1, 1)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  })).toEqual([247, 248, 239, 255])
  await expect(page.locator('body')).toHaveCSS('margin', '0px')
  await expect(page.locator('#root')).toHaveCSS('isolation', 'isolate')
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
  await page.getByRole('dialog').getByLabel('网址', { exact: true }).fill('javascript:alert(1)')
  await expect(page.getByRole('dialog')).toContainText('请输入网页、浏览器页面、扩展页面或本地文件的网址')
  await page.screenshot({ path: 'test-results/shared-ui-editor.png', fullPage: true })
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await expect(page.getByRole('link', { name: 'React · 构建交互界面', exact: true })).toHaveAttribute('href', 'https://react.dev/')
  await card.hover()
  await card.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await createCollection(page, '设计与灵感')
  const collection = page.getByRole('region', { name: '收藏块 设计与灵感' })
  await drag(page, page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), collection)
  await page.screenshot({ path: 'test-results/workbench-desktop.png', fullPage: true })
  for (const width of [1800, 1200, 1100, 1000, 650, 360]) {
    await page.setViewportSize({ width, height: 900 })
    const main = (await page.getByRole('main').boundingBox())!
    const sidebar = (await page.locator('.sidebar').boundingBox())!
    expect(main.x).toBeGreaterThanOrEqual(sidebar.x + sidebar.width)
    expect(main.x + main.width).toBeLessThanOrEqual(width)
    expect(main.y + main.height).toBeLessThanOrEqual(900)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
    await expect(page.getByRole('button', { name: '新建空间', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '新建收藏块', exact: true })).toBeVisible()
    const inbox = page.getByRole('complementary', { name: '待选网页' })
    if (width > 1000) {
      await expect(inbox).toBeVisible()
      expect(main.x + main.width).toBeLessThanOrEqual((await inbox.boundingBox())!.x)
    } else {
      await expect(inbox).toBeHidden()
      // Hiding the inbox must also release its grid column.
      expect(width - main.x - main.width).toBeLessThan(24)
    }
  }
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
  const searchDialog = page.getByRole('dialog', { name: '搜索收藏', exact: true })
  await expect(searchDialog).toHaveCSS('opacity', '1')
  const bounds = (await searchDialog.boundingBox())!
  expect(bounds.x + bounds.width / 2).toBeCloseTo(480 / 2, 0)
  expect(bounds.y + bounds.height / 2).toBeCloseTo(900 / 2, 0)
  expect(bounds.x).toBeGreaterThanOrEqual(16)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(480 - 16)
  expect(bounds.height).toBeLessThanOrEqual(900 * 0.85)
  await page.keyboard.press('Shift+Tab')
  const close = searchDialog.getByRole('button', { name: '关闭弹窗', exact: true })
  await expect(close).toBeFocused()
  await expect(close).toHaveCSS('outline-style', 'solid')
  await expect(close).toHaveCSS('outline-width', '2px')
  await page.screenshot({ path: 'test-results/shared-ui-mobile-search.png', fullPage: true })
  await page.keyboard.press('Enter')
  await expect(searchDialog).toHaveCount(0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  for (const width of [1500, 480]) {
    await page.setViewportSize({ width, height: 900 })
    const address = page.getByLabel('WebDAV 地址')
    await address.focus()
    await expect(address).toBeFocused()
    await expect(address).not.toHaveCSS('box-shadow', 'none')
    const username = (await page.getByLabel('用户名', { exact: true }).boundingBox())!
    const password = (await page.getByLabel('密码或应用专用密码').boundingBox())!
    if (width > 650) expect(password.x).toBeGreaterThan(username.x + username.width)
    else expect(password.y).toBeGreaterThan(username.y + username.height)
    const viewport = page.getByRole('region', { name: '页面内容', exact: true })
    expect(await viewport.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: `test-results/settings-${width}.png`, fullPage: true })
  }
})

test('中央内容独立滚动，顶部操作固定且滚动条不占宽度，切页和搜索定位正常', async () => {
  const { page } = await openClient()
  await page.setViewportSize({ width: 1100, height: 760 })
  await connect(page)
  const legacy = JSON.parse(await readFile(resolve('tests/fixtures/legacy-snapshot.json'), 'utf8'))
  for (let index = 1; index <= 18; index++) {
    const id = `scroll-link-${index}`
    legacy.document.entities[id] = { ...legacy.document.entities.legacyA, id, title: `滚动收藏 ${index}`, url: `https://example.com/${index}`, position: (index + 1) * 1024, todo: false }
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('导入备份').setInputFiles({ name: 'scrolling-library.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(legacy.document)) })
  await page.getByRole('button', { name: '历史空间', exact: true }).click()

  const viewport = page.getByRole('region', { name: '页面内容', exact: true })
  await expect(viewport).toHaveCSS('overscroll-behavior-y', 'contain')
  await expect(viewport).toHaveCSS('scroll-padding-block', '16px')
  const scrollbar = page.locator('.content-scroll .os-scrollbar-vertical')
  await expect(scrollbar).toHaveCSS('right', '3px')
  await expect(scrollbar).toHaveCSS('width', '14px')
  const handle = scrollbar.locator('.os-scrollbar-handle')
  await expect(handle).toHaveCSS('min-height', '44px')
  await expect(handle).toHaveCSS('transition-duration', '0.18s, 0.18s')
  const heading = page.getByRole('heading', { name: '历史空间', exact: true })
  const create = page.getByRole('button', { name: '新建收藏块', exact: true })
  const beforeHeading = (await heading.boundingBox())!
  const beforeCreate = (await create.boundingBox())!
  await viewport.hover()
  await page.mouse.wheel(0, 560)
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(300)
  expect((await heading.boundingBox())!.y).toBeCloseTo(beforeHeading.y, 1)
  expect((await create.boundingBox())!.y).toBeCloseTo(beforeCreate.y, 1)
  expect(await viewport.evaluate(element => (element as HTMLElement).offsetWidth - element.clientWidth)).toBe(0)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await create.click()
  await expect(page.getByRole('textbox', { name: '收藏块名称' })).toBeVisible()
  await page.getByRole('button', { name: '取消', exact: true }).click()

  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
  await page.getByRole('button', { name: '历史空间', exact: true }).click()
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await page.getByRole('searchbox', { name: '搜索全部收藏', exact: true }).fill('历史待办 C')
  await page.getByRole('button', { name: '定位收藏', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '搜索收藏', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: '历史待办 C', exact: true })).toBeInViewport()
  expect((await heading.boundingBox())!.y).toBeCloseTo(beforeHeading.y, 1)
  expect(await page.evaluate(() => window.scrollY)).toBe(0)
  await heading.click()
  await page.screenshot({ path: 'test-results/frosted-panel-desktop.png' })

  await page.setViewportSize({ width: 480, height: 760 })
  const mobileHeading = (await heading.boundingBox())!
  await viewport.press('Control+Home')
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
  await viewport.press('PageDown')
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(0)
  await expect(viewport).toHaveCSS('outline-style', 'solid')
  await expect(viewport).toHaveCSS('outline-width', '2px')
  await expect(viewport).toHaveCSS('outline-offset', '-3px')
  expect((await heading.boundingBox())!.y).toBeCloseTo(mobileHeading.y, 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(480)
  await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '待选网页' })).toBeVisible()
  await page.getByRole('button', { name: '关闭待选网页', exact: true }).click()
  await heading.click()
  await page.screenshot({ path: 'test-results/frosted-panel-mobile.png' })
})

for (const mode of ['animated', 'disabled', 'reduced-motion']) test(`画布首次绘制延迟时品牌和昵称始终可见，完成后无重复内容（${mode}）`, async () => {
  const { page } = await openClient()
  await connect(page)
  if (mode === 'disabled') {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
  }
  if (mode === 'reduced-motion') await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.addInitScript(() => {
    let held = true
    const pending = new Map<EventListenerOrEventListenerObject, { target: EventTarget; event: Event }>()
    const original = EventTarget.prototype.addEventListener
    EventTarget.prototype.addEventListener = function(type, listener, options) {
      if (type !== 'paint' || !listener || !(this instanceof HTMLCanvasElement)) return original.call(this, type, listener, options)
      const invoke = (target: EventTarget, event: Event) => {
        if (typeof listener === 'function') listener.call(target, event)
        else listener.handleEvent(event)
      }
      return original.call(this, type, function(this: EventTarget, event: Event) {
        if (held) pending.set(listener, { target: this, event })
        else invoke(this, event)
      }, options)
    }
    Object.assign(window, { releaseFluidPaint() {
      held = false
      for (const [listener, { target, event }] of pending) {
        if (typeof listener === 'function') listener.call(target, event)
        else listener.handleEvent(event)
      }
      pending.clear()
    } })
  })
  await page.reload()
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
  async function ink(clip: { x: number; y: number; width: number; height: number }) {
    const data = (await page.screenshot({ clip })).toString('base64')
    return page.evaluate(async data => {
      const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob())
      const ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
      let count = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 120 && pixels[i + 1] < 140 && pixels[i + 2] < 120) count++
      bitmap.close()
      return count
    }, data)
  }
  const brand = { x: 20, y: 34, width: 185, height: 40 }
  const profile = { x: 30, y: 104, width: 170, height: 36 }
  await page.screenshot({ path: `test-results/fluid-first-paint-${mode}-held.png` })
  expect(await ink(brand), '品牌在首次画布帧之前仍有可见文字').toBeGreaterThan(150)
  expect(await ink(profile), '昵称在首次画布帧之前仍有可见文字').toBeGreaterThan(40)
  await page.evaluate(() => (window as unknown as { releaseFluidPaint(): void }).releaseFluidPaint())
  await expect(page.locator('[data-fluid-placeholder]')).toHaveCount(0)
  await expect.poll(() => ink(brand)).toBeGreaterThan(150)
  await expect.poll(() => ink(profile)).toBeGreaterThan(40)
  await expect(page.getByRole('img', { name: '页墟 Page Garden', exact: true })).toHaveCount(1)
  await expect(page.getByRole('img', { name: '用户 Rain', exact: true })).toHaveCount(1)
  await page.screenshot({ path: `test-results/fluid-first-paint-${mode}-ready.png` })
})

test('品牌和昵称使用 HTML 场景，动态更新、长昵称和窄窗口布局保持正常', async () => {
  const { page } = await openClient()
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await connect(page)
  const scene = page.locator('[data-fluid-scene]')
  const brand = scene.getByRole('img', { name: '页墟 Page Garden', exact: true })
  const profile = scene.getByRole('img', { name: '用户 Rain', exact: true })
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
  expect(await scene.evaluate(node => node.parentElement instanceof HTMLCanvasElement)).toBe(true)
  await expect(brand).toBeVisible()
  await expect(profile).toContainText('Rain')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const nickname = '🌱很长的用户昵称'.repeat(6)
  await page.getByLabel('显示昵称', { exact: true }).fill(nickname)
  const updatedProfile = scene.getByRole('img', { name: `用户 ${nickname}`, exact: true })
  await expect(updatedProfile).toContainText(nickname)
  await expect(updatedProfile.locator('span').first()).toHaveText('🌱')
  expect(await updatedProfile.locator('span').last().evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)
  await page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
  await page.getByLabel('显示昵称', { exact: true }).fill('静态昵称')
  await expect(scene.getByRole('img', { name: '用户 静态昵称', exact: true })).toBeVisible()
  for (const width of [1800, 1500, 1200, 1000, 651, 650, 390]) {
    await page.setViewportSize({ width, height: 960 })
    const sidebar = await page.locator('.sidebar').boundingBox()
    const box = (await brand.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(sidebar!.x)
    expect(box.x + box.width).toBeLessThanOrEqual(sidebar!.x + sidebar!.width)
    const user = scene.getByRole('img', { name: '用户 静态昵称', exact: true })
    if (width <= 650) await expect(user).toBeHidden()
    else {
      await expect(user).toBeVisible()
      const userBox = (await user.boundingBox())!
      expect(userBox.y).toBeCloseTo(box.y + box.height + (width <= 1200 ? 28 : 30), 0)
    }
  }
  await page.screenshot({ path: 'test-results/fluid-html-mobile.png' })
  await page.setViewportSize({ width: 1500, height: 960 })
  await page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
  await page.screenshot({ path: 'test-results/fluid-html-desktop.png' })
  expect(errors).toEqual([])
})

test('Chrome 缺少 HTML in Canvas 能力时保留品牌与昵称 HTML', async () => {
  const { page } = await openClient()
  await connect(page)
  await page.addInitScript(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'updateElementGeometry', { configurable: true, value: undefined })
  })
  await page.reload()
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'fallback')
  const scene = page.locator('[data-fluid-scene]')
  expect(await scene.evaluate(node => node.parentElement instanceof HTMLCanvasElement)).toBe(false)
  await expect(scene.getByRole('img', { name: '页墟 Page Garden', exact: true })).toBeVisible()
  await expect(scene.getByRole('img', { name: '用户 Rain', exact: true })).toContainText('Rain')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('显示昵称', { exact: true }).fill('HTML 降级昵称')
  await expect(scene.getByRole('img', { name: '用户 HTML 降级昵称', exact: true })).toContainText('HTML 降级昵称')
  await page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
  await expect(scene.getByRole('img', { name: '用户 HTML 降级昵称', exact: true })).toBeVisible()
})

test('个人偏好 Switch 支持键盘操作，流体动画可立即关闭、重开及同步', async () => {
  const { page, context, url } = await openClient()
  await connect(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const animation = page.getByRole('switch', { name: '流体背景动画', exact: true })
  const takeover = page.getByRole('switch', { name: '自动接管 Markdown 地址', exact: true })
  await expect(takeover).toBeChecked()
  await expect(animation).toBeChecked()
  await expect(page.locator('canvas[data-fluid="active"]')).toHaveCount(1)
  await expect(page.locator('[data-fluid-scene] [aria-label="页墟 Page Garden"]')).toBeVisible()
  await expect(page.locator('[data-fluid-scene] [aria-label^="用户 "]')).toBeVisible()
  await animation.click()
  await expect(animation).not.toBeChecked()
  await expect(animation).toBeEnabled()
  await expect(page.locator('canvas[data-fluid="active"]')).toHaveCount(0)
  await expect(page.locator('canvas[data-fluid="idle"]')).toHaveCount(1)
  await expect(page.locator('[data-fluid-scene] [aria-label="页墟 Page Garden"]')).toBeVisible()
  await expect(page.locator('[data-fluid-scene] [aria-label^="用户 "]')).toBeVisible()
  await page.getByText('流体背景动画', { exact: true }).click()
  await expect(animation).toBeChecked()
  await expect(page.locator('canvas[data-fluid="active"]')).toHaveCount(1)
  await animation.focus()
  await page.keyboard.press('Space')
  await expect(animation).not.toBeChecked()
  await expect(page.locator('canvas[data-fluid="active"]')).toHaveCount(0)
  await expect(page.locator('canvas[data-fluid="idle"]')).toHaveCount(1)
  await expect(page.locator('[data-fluid-scene] [aria-label="页墟 Page Garden"]')).toBeVisible()
  await expect(page.locator('[data-fluid-scene] [aria-label^="用户 "]')).toBeVisible()
  await page.screenshot({ path: 'test-results/settings-switches-desktop.png', fullPage: true })
  const otherTab = await context.newPage()
  await otherTab.goto(url)
  await expect(otherTab.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
  await expect(otherTab.locator('canvas[data-fluid="active"]')).toHaveCount(0)
  await expect(otherTab.locator('canvas[data-fluid="idle"]')).toHaveCount(1)
  await expect(otherTab.locator('[data-fluid-scene] [aria-label="页墟 Page Garden"]')).toBeVisible()
  await otherTab.close()
  await page.reload()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(animation).not.toBeChecked()
  await expect(page.locator('canvas[data-fluid="active"]')).toHaveCount(0)
  await expect(page.locator('canvas[data-fluid="idle"]')).toHaveCount(1)
  await sync(page)
  const second = await openClient()
  await connect(second.page)
  await second.page.getByRole('button', { name: '设置', exact: true }).click()
  await expect(second.page.getByRole('switch', { name: '流体背景动画', exact: true })).not.toBeChecked()
  await expect(second.page.locator('canvas[data-fluid="active"]')).toHaveCount(0)
  await expect(second.page.locator('canvas[data-fluid="idle"]')).toHaveCount(1)
  await expect(second.page.locator('[data-fluid-scene] [aria-label="页墟 Page Garden"]')).toBeVisible()
  await second.page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
  await sync(second.page)
  await sync(page)
  await expect(animation).toBeChecked()
  await expect(page.locator('canvas[data-fluid="active"]')).toHaveCount(1)
})

test('卡片和中央滚动区的输入继续驱动底层流体，画布保持在内容下方', async () => {
  const { page } = await openClient()
  await connect(page)
  await addLink(page, '底层流体输入')
  for (const target of ['card', 'scroll']) {
    await page.reload()
    await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
    await expect(page.locator('canvas')).toHaveCount(1)
    const panel = page.locator('main.main-content')
    const card = page.getByRole('article', { name: '链接 底层流体输入', exact: true })
    const box = (await (target === 'card' ? card : panel).boundingBox())!
    const x = box.x + 20
    const y = target === 'card' ? box.y + box.height / 2 : box.y + box.height - 180
    expect(await page.evaluate(({ x, y, target }) => {
      const hit = document.elementFromPoint(x, y)
      const canvas = document.querySelector('canvas')!
      const main = document.querySelector('main.main-content')!
      return !!hit?.closest(target === 'card' ? 'article' : '[data-overlayscrollbars-viewport]') &&
        Number(getComputedStyle(canvas.parentElement!).zIndex) < Number(getComputedStyle(main.closest('.workbench')!).zIndex)
    }, { x, y, target })).toBe(true)
    // Expose only the underlying pixels for this assertion. Opacity preserves
    // the real card/link/scroll hit targets; production paint order stays intact.
    await panel.evaluate(node => { node.style.opacity = '0' })
    await page.mouse.move(x, y)
    await page.waitForTimeout(400)
    const clip = { x: Math.floor(box.x), y: Math.floor(y - 80), width: Math.floor(Math.min(box.width, 400)), height: 160 }
    const before = await page.screenshot({ clip })
    await page.mouse.move(x + Math.min(box.width - 40, 240), y, { steps: 24 })
    await expect.poll(async () => (await page.screenshot({ clip })).equals(before), { timeout: 3000, message: target }).toBe(false)
    await panel.evaluate(node => { node.style.removeProperty('opacity') })
  }
  await page.getByRole('article', { name: '链接 底层流体输入', exact: true }).getByRole('button', { name: '编辑链接', exact: true }).click()
  await expect(page.getByRole('dialog')).toBeVisible()
})

test('鼠标在交互按钮上移动也能触发流体动画', async () => {
  const { page } = await openClient()
  await connect(page)
  await page.reload()
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
  const button = page.getByRole('button', { name: /^Todo/ })
  const box = (await button.boundingBox())!
  const clip = { x: 0, y: Math.floor(box.y - 15), width: 225, height: Math.ceil(box.height + 30) }
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  expect(await button.evaluate(node => node.matches(':hover'))).toBe(true)
  await page.waitForTimeout(400) // Let the button's existing hover transition finish.
  const before = await page.screenshot({ clip })
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 20 })
  await expect.poll(async () => (await page.screenshot({ clip })).equals(before), { timeout: 3000 }).toBe(false)
  await button.click()
  await expect(page.getByRole('heading', { name: 'Todo', exact: true })).toBeVisible()
})

test('动画关闭或系统减少动态效果时，交互按钮上的移动不产生波纹', async () => {
  const { page } = await openClient()
  await connect(page)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
  for (const mode of ['disabled', 'reduced-motion']) {
    if (mode === 'reduced-motion') {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('switch', { name: '流体背景动画', exact: true }).click()
      await page.emulateMedia({ reducedMotion: 'reduce' })
    }
    await page.reload()
    await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
    const button = page.getByRole('button', { name: /^Todo/ })
    const box = (await button.boundingBox())!
    const clip = { x: 0, y: Math.floor(box.y - 15), width: 225, height: Math.ceil(box.height + 30) }
    await page.mouse.move(box.x + 20, box.y + box.height / 2)
    await page.waitForTimeout(400)
    const before = await page.screenshot({ clip })
    await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 20 })
    await page.waitForTimeout(150)
    expect((await page.screenshot({ clip })).equals(before), mode).toBe(true)
  }
})

test('浅色流体背景响应鼠标，仍可打开弹窗和正常收藏', async () => {
  const { page } = await openClient()
  await connect(page)
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'native')
  const clip = { x: 245, y: 5, width: 400, height: 90 }
  await page.mouse.move(100, 900)
  const before = await page.screenshot({ clip })
  await page.mouse.move(260, 35)
  await page.mouse.move(620, 65, { steps: 25 })
  await expect.poll(async () => (await page.screenshot({ clip })).equals(before), { timeout: 5000 }).toBe(false)
  await page.screenshot({ path: 'test-results/fluid-desktop.png', fullPage: true })
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
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
  await expect(page.locator('[data-html-source-status]')).toHaveAttribute('data-html-source-status', 'fallback')
  await expect(page.locator('[data-fluid-scene]').getByRole('img', { name: '用户 Rain', exact: true })).toContainText('Rain')
  await expect(page.locator('[data-fluid-scene]').getByRole('img', { name: '页墟 Page Garden', exact: true })).toBeVisible()
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

test('WebDAV 旧版待办可读取，排序与备份恢复保留，拖入 Todo 不产生操作', async () => {
  const legacy = JSON.parse(await readFile(resolve('tests/fixtures/legacy-snapshot.json'), 'utf8'))
  files.set('/dav/new-page/data-v1.json', { body: JSON.stringify(legacy.document), revision: 1 })
  const { page, context } = await openClient()
  await connect(page, '/dav/', '历史空间')
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
  await expect(second.page.getByRole('alert').filter({ hasText: '目标数据源有未解决冲突' })).toBeVisible()
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
  await createSpace(first.page, '另一空间')
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
  await expect(second.page.getByRole('alert').filter({ hasText: '目标数据源有未解决冲突' })).toBeVisible()
  await changeSource(second.page, '/dav/')
  await expect(second.page.getByText('目标远端修改版本', { exact: true })).toBeVisible()
  await expect(second.page.getByText('目标尚未上传版本', { exact: true })).toHaveCount(2)
})

test('同排序值的收藏在卡片和块之间插入仍与占位一致', async () => {
  const legacy = JSON.parse(await readFile(resolve('tests/fixtures/legacy-snapshot.json'), 'utf8'))
  for (const entity of Object.values(legacy.document.entities) as { kind: string; position: number }[]) if (entity.kind === 'collection') entity.position = 1024
  legacy.document.entities.legacyB.parentId = 'legacyCollection'
  files.set('/dav/new-page/data-v1.json', { body: JSON.stringify(legacy.document), revision: 1 })
  const { page, context } = await openClient()
  await connect(page, '/dav/', '历史空间')
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/guide`)
  await drag(page, page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }), page.getByRole('article', { name: '链接 历史待办 B', exact: true }))
  const original = page.getByRole('region', { name: '收藏块 历史收藏', exact: true })
  await expect(original.getByRole('link')).toHaveText(['历史待办 A', 'UnoCSS 指南', '历史待办 B'])
  await expect.poll(() => tab.isClosed()).toBe(true)
  await holdAtEdge(page, page.getByRole('article', { name: '链接 历史待办 C', exact: true }), original)
  await expect(page.getByText('松手新建收藏块', { exact: true })).toBeVisible({ timeout: 4000 })
  await page.mouse.up()
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['历史收藏3', '新收藏1', '历史收藏 B0', '历史收藏 C0'])
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('list', { name: '待办清单' }).getByRole('link')).toHaveText(['历史待办 A', '历史待办 B', '历史待办 C'])
  await page.reload()
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['历史收藏3', '新收藏1', '历史收藏 B0', '历史收藏 C0'])
})

test('键盘仍可直接调整整个收藏块和空间的顺序', async () => {
  const { page } = await openClient()
  await connect(page)
  await createCollection(page, '键盘排序收藏块')
  await page.getByRole('region', { name: '收藏块 键盘排序收藏块', exact: true }).focus()
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  const collectionY = (await page.locator('.drag-preview').boundingBox())!.y
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())!.y).toBeLessThan(collectionY)
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('heading', { level: 2 })).toHaveText(['键盘排序收藏块0', '日常收藏0'])
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  await createSpace(page, '键盘排序空间')
  await page.getByRole('button', { name: '键盘排序空间', exact: true }).locator('..').focus()
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  const spaceY = (await page.locator('.drag-preview').boundingBox())!.y
  await page.keyboard.press('ArrowUp')
  await expect.poll(async () => (await page.locator('.drag-preview').boundingBox())!.y).toBeLessThan(spaceY)
  await page.keyboard.press('Space', { delay: 100 })
  await expect(page.getByRole('navigation', { name: '空间', exact: true }).getByRole('button', { name: /^(我的空间|键盘排序空间)$/ })).toHaveText(['键盘排序空间', '我的空间'])
})

test('一键收藏按点击时间在空间顶部保存全部待选网页后关闭原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const duplicate = await context.newPage()
  await duplicate.goto(`${origin}/web/react`)
  const pinned = await context.newPage()
  await pinned.goto(`${origin}/web/guide`)
  await page.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url })
    await chrome.tabs.update(tab.id!, { pinned: true })
  }, pinned.url())
  const special = await context.newPage()
  await special.goto('chrome://version/')
  const specialTitle = await special.title()
  await page.bringToFront()
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(inbox.getByRole('article')).toHaveCount(4)
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 10, 12, 15, 4, 9).getTime()))
  await inbox.getByRole('button', { name: '一键收藏', exact: true }).click()
  const block = page.getByRole('region', { name: '收藏块 收藏 2026-11-12 15:04:09', exact: true })
  await expect(block.getByRole('link')).toHaveText(['UnoCSS 指南', 'React 文档', 'React 文档', specialTitle])
  await expect(page.getByRole('region', { name: /^收藏块/ }).first()).toHaveAttribute('aria-label', '收藏块 收藏 2026-11-12 15:04:09')
  await expect(block.getByRole('button', { name: '加入 Todo', exact: true })).toHaveCount(4)
  await expect.poll(() => [first, duplicate, pinned, special].every(tab => tab.isClosed())).toBe(true)
  await expect(inbox.getByRole('button', { name: '一键收藏', exact: true })).toBeDisabled()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.reload()
  await expect(block.getByRole('link')).toHaveText(['UnoCSS 指南', 'React 文档', 'React 文档', specialTitle])
})

test('特殊页面和本地文件一键收藏、重载并通过浏览器接口重新打开', async () => {
  const { page, context, profile, url } = await openClient()
  await connect(page)
  const extension = join(profile, 'other-extension')
  await mkdir(extension)
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Other extension fixture', version: '1.0', web_accessible_resources: [{ resources: ['page.html'], matches: ['<all_urls>'], extension_ids: ['*'] }] }))
  await writeFile(join(extension, 'page.html'), '<title>Other extension</title><h1>Other extension</h1>')
  const session = await context.browser()!.newBrowserCDPSession()
  const other = await session.send('Extensions.loadUnpacked', { path: extension })
  const localPath = join(profile, '本地页面.html')
  await writeFile(localPath, '<title>本地文件示例</title><h1>Local file</h1>')
  const urls = ['chrome://settings/', 'chrome://extensions/', 'about:blank', 'chrome-extension://' + other.id + '/page.html', pathToFileURL(localPath).href]
  const ids = await page.evaluate(async urls => {
    const ids: number[] = []
    for (const url of urls) ids.push((await chrome.tabs.create({ url, active: false })).id!)
    return ids
  }, urls)
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(inbox.getByRole('article')).toHaveCount(urls.length)
  const savedUrls = await page.evaluate(async ids => Promise.all(ids.map(async id => (await chrome.tabs.get(id)).url!)), ids)
  expect(savedUrls).not.toContain(url)
  await inbox.getByRole('button', { name: '一键收藏', exact: true }).click()
  const block = page.getByRole('region', { name: /^收藏块 收藏 / })
  await expect(block.getByRole('link')).toHaveCount(urls.length)
  await expect.poll(() => page.evaluate(async ids => {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    return tabs.some(tab => ids.includes(tab.id!))
  }, ids)).toBe(false)
  await page.reload()
  await expect(block.getByRole('link')).toHaveCount(urls.length)
  await page.screenshot({ path: test.info().outputPath('special-pages-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 480, height: 900 })
  await page.screenshot({ path: test.info().outputPath('special-pages-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1500, height: 960 })
  for (const saved of savedUrls) {
    const link = block.locator('a[href=' + JSON.stringify(saved) + ']')
    await expect(link).toHaveCount(1)
    const openedPromise = context.waitForEvent('page')
    await link.click()
    const opened = await openedPromise
    await expect(opened).toHaveURL(saved)
    if (saved.startsWith('file:')) await expect(opened.getByRole('heading', { name: 'Local file', exact: true })).toBeVisible()
    await opened.close()
  }
  await expect(inbox.getByRole('article')).toHaveCount(0)
  await sync(page)
  const second = await openClient()
  await connect(second.page)
  await expect(second.page.getByRole('region', { name: /^收藏块 收藏 / }).getByRole('link')).toHaveCount(urls.length)
})

test('本扩展页面打开多个时全部排除，一键收藏只处理其他页面', async () => {
  const { page, context, url } = await openClient()
  await connect(page)
  const ownIds = await page.evaluate(async url => {
    const ids: number[] = []
    for (const address of [url, url + '?copy=1', url + '#copy', 'chrome://newtab/']) {
      ids.push((await chrome.tabs.create({ url: address, active: false })).id!)
    }
    return ids
  }, url)
  await expect.poll(() => page.evaluate(async ids => Promise.all(ids.map(async id => (await chrome.tabs.get(id)).status)), ownIds)).toEqual(ownIds.map(() => 'complete'))
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(inbox.getByRole('article')).toHaveCount(0)
  await expect(inbox.getByRole('heading', { level: 2 })).toHaveText('待选网页 0')
  await expect(inbox.getByRole('button', { name: '一键收藏', exact: true })).toBeDisabled()
  const changing = await context.newPage()
  await changing.goto(origin + '/web/react')
  await expect(inbox.getByRole('article')).toHaveCount(1)
  await changing.goto(url + '?copy=dynamic')
  await expect(inbox.getByRole('article')).toHaveCount(0)
  await changing.goto(origin + '/web/react')
  const special = await context.newPage()
  await special.goto('chrome://version/')
  await page.bringToFront()
  await expect(inbox.getByRole('article')).toHaveCount(2)
  await inbox.getByRole('button', { name: '一键收藏', exact: true }).click()
  await expect(page.getByRole('region', { name: /^收藏块 收藏 / }).getByRole('link')).toHaveCount(2)
  await expect.poll(() => changing.isClosed() && special.isClosed()).toBe(true)
  await expect.poll(() => page.evaluate(async ids => {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    return tabs.filter(tab => ids.includes(tab.id!)).length
  }, ownIds)).toBe(ownIds.length)
  await page.reload()
  await expect(inbox.getByRole('article')).toHaveCount(0)
})

test('特殊页面拖入后支持编辑、Todo 和搜索打开，失败可重试', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const special = await context.newPage()
  await special.goto('chrome://version/')
  const title = await special.title()
  await page.bringToFront()
  await drag(page, page.getByRole('article', { name: '待选 ' + title, exact: true }), page.getByRole('region', { name: /^收藏块/ }).first())
  await expect.poll(() => special.isClosed()).toBe(true)
  const card = page.getByRole('article', { name: '链接 ' + title, exact: true })
  await card.hover()
  await card.getByRole('button', { name: '编辑链接', exact: true }).click()
  const input = page.getByRole('dialog').getByLabel('网址', { exact: true })
  await input.fill('chrome://extensions/')
  await expect(card.getByRole('link')).toHaveAttribute('href', 'chrome://extensions/')
  for (const unsupported of ['javascript:alert(1)', 'data:text/html,test', 'blob:https://example.com/test']) {
    await input.fill(unsupported)
    await expect(page.getByRole('dialog').getByRole('alert')).toContainText('请输入网页')
    await expect(card.getByRole('link')).toHaveAttribute('href', 'chrome://extensions/')
  }
  await page.getByRole('button', { name: '关闭弹窗', exact: true }).click()
  await card.hover()
  await card.getByRole('button', { name: '加入 Todo', exact: true }).click()
  await page.getByRole('button', { name: /^Todo/ }).click()
  let openedPromise = context.waitForEvent('page')
  await page.getByRole('list', { name: '待办清单' }).getByRole('link').click({ button: 'middle' })
  let opened = await openedPromise
  await expect(opened).toHaveURL('chrome://extensions/')
  await opened.close()
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await page.getByRole('dialog').getByLabel('搜索全部收藏').fill(title)
  const result = page.getByRole('dialog').getByRole('link', { name: title, exact: true })
  await page.evaluate(() => {
    const create = chrome.tabs.create.bind(chrome.tabs)
    let fail = true
    chrome.tabs.create = (async options => {
      if (fail) { fail = false; throw new Error('受控打开失败') }
      return create(options)
    }) as typeof chrome.tabs.create
  })
  await result.click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('无法打开此页面')
  openedPromise = context.waitForEvent('page')
  await result.focus()
  await page.keyboard.press('Enter')
  opened = await openedPromise
  await expect(opened).toHaveURL('chrome://extensions/')
  await opened.close()
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveCount(0)
})

test('单条关闭准确移除对应浏览器标签，失败保留条目且不触发收藏', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const duplicate = await context.newPage()
  await duplicate.goto(`${origin}/web/react`)
  await page.bringToFront()
  const rows = page.getByRole('article', { name: '待选 React 文档', exact: true })
  await expect(rows).toHaveCount(2)
  await rows.first().getByRole('button', { name: '关闭标签页 React 文档', exact: true }).click()
  await expect.poll(() => first.isClosed()).toBe(true)
  expect(duplicate.isClosed()).toBe(false)
  await expect(rows).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toHaveCount(0)
  await page.evaluate(() => { chrome.tabs.remove = async () => { throw new Error('受控关闭失败') } })
  await rows.getByRole('button', { name: '关闭标签页 React 文档', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('无法关闭标签页')
  await expect(rows).toHaveCount(1)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  expect(duplicate.isClosed()).toBe(false)
})

test('待选上下排序同步浏览器顺序并包含特殊页面', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const hidden = await context.newPage()
  await hidden.goto('chrome://version/')
  const specialTitle = await hidden.title()
  const last = await context.newPage()
  await last.goto(`${origin}/web/guide`)
  await page.bringToFront()
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  const source = inbox.getByRole('article', { name: '待选 UnoCSS 指南', exact: true })
  const target = inbox.getByRole('article', { name: '待选 React 文档', exact: true })
  await drag(page, source, target)
  await expect.poll(() => inbox.getByRole('article').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))).toEqual(['待选 UnoCSS 指南', '待选 React 文档', '待选 ' + specialTitle])
  const browserOrder = () => page.evaluate(async () => {
    const owner = await chrome.tabs.getCurrent()
    return (await chrome.tabs.query({ windowId: owner!.windowId })).map(tab => tab.url).filter(url => url?.includes('/web/') || url === 'chrome://version/')
  })
  await expect.poll(browserOrder).toEqual([last.url(), first.url(), 'chrome://version/'])
  await drag(page, source, target)
  await expect.poll(browserOrder).toEqual([first.url(), last.url(), 'chrome://version/'])
  expect(first.isClosed()).toBe(false)
  expect(last.isClosed()).toBe(false)
  await expect(page.getByRole('link', { name: /React 文档|UnoCSS 指南/ })).toHaveCount(0)
})

test('一键收藏固定点击快照，执行中不重复提交且保留已变化的原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const changed = await context.newPage()
  await changed.goto(`${origin}/web/react`)
  const moved = await context.newPage()
  await moved.goto(`${origin}/web/react`)
  const removed = await context.newPage()
  await removed.goto(`${origin}/web/react`)
  const unchanged = await context.newPage()
  await unchanged.goto(`${origin}/web/react`)
  await expect(page.getByRole('article', { name: '待选 React 文档', exact: true })).toHaveCount(4)
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 10, 12, 15, 4, 9).getTime()))
  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime) as (request: unknown) => Promise<unknown>
    chrome.runtime.sendMessage = ((request: { type?: string; action?: { type?: string } }) => {
      if (request.type === 'action' && request.action?.type === 'collect-tabs') {
        return new Promise<unknown>(resolve => { (window as unknown as Window & { releaseTabAction(): void }).releaseTabAction = () => { void send(request).then(resolve) } })
      }
      return send(request)
    }) as typeof chrome.runtime.sendMessage
    const remove = chrome.tabs.remove.bind(chrome.tabs) as (id: number) => Promise<void>
    chrome.tabs.remove = (async (id: number) => {
      const tab = await chrome.tabs.get(id)
      if (tab.title === 'React 文档') throw new Error('受控部分关闭失败')
      return remove(id)
    }) as typeof chrome.tabs.remove
  })
  await page.bringToFront()
  const collect = page.getByRole('button', { name: '一键收藏', exact: true })
  await collect.dblclick()
  await expect(collect).toBeDisabled()
  await expect(page.getByRole('region', { name: /^收藏块 收藏 / })).toHaveCount(0)
  expect(changed.isClosed()).toBe(false)
  await changed.goto(`${origin}/web/guide`)
  await page.evaluate(async () => {
    const owner = await chrome.tabs.getCurrent()
    const list = await chrome.tabs.query({ windowId: owner!.windowId })
    const tabs = list.filter(tab => tab.title === 'React 文档')
    await chrome.windows.create({ tabId: tabs[0].id, focused: false })
  })
  await removed.close()
  const added = await context.newPage()
  await added.goto(`${origin}/web/guide`)
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 10, 12, 15, 5, 10).getTime()))
  unavailable = true
  await page.evaluate(() => (window as unknown as Window & { releaseTabAction(): void }).releaseTabAction())
  const block = page.getByRole('region', { name: '收藏块 收藏 2026-11-12 15:04:09', exact: true })
  await expect(block.getByRole('link')).toHaveText(['React 文档', 'React 文档', 'React 文档', 'React 文档'])
  await expect(page.getByRole('region', { name: /^收藏块 收藏 / })).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('原标签页已变化')
  await expect(page.getByRole('alert')).toContainText('无法关闭原标签页')
  expect([changed, moved, unchanged, added].every(tab => !tab.isClosed())).toBe(true)
  await expect(collect).toBeEnabled()
  await page.reload()
  await expect(block.getByRole('link')).toHaveCount(4)
})

for (const input of ['键盘', '触摸'] as const) test(`${input}在窄屏待选抽屉排序并显示插入位置`, async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const last = await context.newPage()
  await last.goto(`${origin}/web/guide`)
  await page.setViewportSize({ width: 480, height: 900 })
  await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
  const source = page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true })
  const target = page.getByRole('article', { name: '待选 React 文档', exact: true })
  const session = input === '触摸' ? await context.newCDPSession(page) : null
  if (session) {
    await session.send('Emulation.setTouchEmulationEnabled', { enabled: true })
    await source.click({ trial: true })
    const from = (await source.boundingBox())!
    const to = (await target.boundingBox())!
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x + 55, y: from.y + 25 }] })
    await expect(source).toHaveAttribute('data-dragging', 'true')
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: to.x + 55, y: to.y + 25 }] })
  } else {
    await source.focus()
    await page.keyboard.press('Space', { delay: 100 })
    await expect(page.locator('.drag-preview')).toBeVisible()
    await page.keyboard.press('ArrowUp')
  }
  await expect(page.locator('.tab-inbox [data-dragging]')).toHaveAttribute('data-dragging', 'true')
  await expect(page.getByRole('img', { name: '标签页放置位置', exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath(`tab-sort-${input}.png`) })
  if (session) await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  else await page.keyboard.press('Space')
  await expect.poll(() => page.getByRole('complementary', { name: '待选网页' }).getByRole('article').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))).toEqual(['待选 UnoCSS 指南', '待选 React 文档'])
  await expect.poll(() => page.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).filter(tab => tab.url?.includes('/web/')).map(tab => tab.url))).toEqual([last.url(), first.url()])
  await target.getByRole('button', { name: '关闭标签页 React 文档', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect.poll(() => first.isClosed()).toBe(true)
  expect(last.isClosed()).toBe(false)
})

test('空空间从 Todo 和设置一键收藏，允许同秒同名且同步到另一设备', async () => {
  const first = await openClient(undefined, true)
  const { page, context } = first
  await connectQuark(page)
  await createSpace(page, '收集空间')
  await page.getByRole('button', { name: '收集空间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '暂无收藏块', exact: true })).toBeVisible()
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 10, 12, 15, 4, 9).getTime()))
  for (const nav of ['Todo', '设置']) {
    const tab = await context.newPage()
    await tab.goto(`${origin}/web/guide`)
    await page.getByRole('button', { name: nav === 'Todo' ? /^Todo/ : '设置', exact: nav !== 'Todo' }).click()
    await page.setViewportSize({ width: 480, height: 900 })
    await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
    await expect(page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true })).toHaveCount(1)
    await page.getByRole('button', { name: '一键收藏', exact: true }).click()
    await expect(page.getByRole('heading', { name: '收集空间', exact: true })).toBeVisible()
    await expect.poll(() => tab.isClosed()).toBe(true)
    await expect(page.getByRole('button', { name: '一键收藏', exact: true })).not.toBeVisible()
    await page.setViewportSize({ width: 1500, height: 960 })
  }
  const blocks = page.getByRole('region', { name: '收藏块 收藏 2026-11-12 15:04:09', exact: true })
  await expect(blocks).toHaveCount(2)
  await expect(blocks.first().getByRole('link')).toHaveText('UnoCSS 指南')
  await expect(blocks.last().getByRole('link')).toHaveText('UnoCSS 指南')
  await sync(page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  await second.page.getByRole('button', { name: '收集空间', exact: true }).click()
  await expect(second.page.getByRole('region', { name: '收藏块 收藏 2026-11-12 15:04:09', exact: true })).toHaveCount(2)
  expect(quark.published()).toHaveLength(1)
  for (const file of quark.published()) expect(file.body).not.toMatch(/tabId|windowId|pinned|groupId/)
  await page.reload()
  await page.getByRole('button', { name: '收集空间', exact: true }).click()
  await expect(blocks).toHaveCount(2)
})

test('一键收藏本地保存失败不留下部分收藏且不关闭原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tabs: Page[] = []
  for (const path of ['react', 'guide']) {
    const tab = await context.newPage()
    await tab.goto(`${origin}/web/${path}`)
    tabs.push(tab)
  }
  await expect(page.getByRole('complementary', { name: '待选网页' }).getByRole('article')).toHaveCount(2)
  await context.serviceWorkers()[0].evaluate(() => {
    const original = chrome.storage.local.set
    chrome.storage.local.set = async () => { chrome.storage.local.set = original; throw new Error('受控批量本地保存失败') }
  })
  await page.getByRole('button', { name: '一键收藏', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('受控批量本地保存失败')
  expect(tabs.every(tab => !tab.isClosed())).toBe(true)
  await expect(page.getByRole('button', { name: '一键收藏', exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole('region', { name: /^收藏块/ })).toHaveCount(1)
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('link')).toHaveCount(0)
})

test('待选排序保持置顶边界，取消和失败恢复真实顺序并跟随浏览器更新', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const tabs: Page[] = []
  for (const [index, title] of ['置顶一', '置顶二', '普通一', '普通二'].entries()) {
    const tab = await context.newPage()
    await tab.goto(`${origin}/web/react?tab=${index}`)
    await tab.evaluate(value => { document.title = value }, title)
    tabs.push(tab)
  }
  await page.evaluate(async urls => {
    for (const url of urls) {
      const [tab] = await chrome.tabs.query({ url })
      await chrome.tabs.update(tab.id!, { pinned: true })
    }
  }, tabs.slice(0, 2).map(tab => tab.url()))
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  const row = (title: string) => inbox.getByRole('article', { name: `待选 ${title}`, exact: true })
  const order = () => inbox.getByRole('article').evaluateAll(rows => rows.map(node => node.getAttribute('aria-label')))
  await expect.poll(order).toEqual(['待选 置顶一', '待选 置顶二', '待选 普通一', '待选 普通二'])
  await drag(page, row('置顶二'), row('置顶一'))
  await expect.poll(order).toEqual(['待选 置顶二', '待选 置顶一', '待选 普通一', '待选 普通二'])
  await drag(page, row('普通二'), row('置顶一'))
  await expect.poll(order).toEqual(['待选 置顶二', '待选 置顶一', '待选 普通一', '待选 普通二'])
  const from = (await row('普通二').boundingBox())!
  const to = (await row('普通一').boundingBox())!
  await page.mouse.move(from.x + 55, from.y + 25)
  await page.mouse.down()
  await page.mouse.move(to.x + 55, to.y + 25, { steps: 12 })
  await expect(page.locator('.tab-inbox [data-dragging]')).toHaveAttribute('data-dragging', 'true')
  await expect(page.getByRole('img', { name: '标签页放置位置', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect.poll(order).toEqual(['待选 置顶二', '待选 置顶一', '待选 普通一', '待选 普通二'])
  await page.evaluate(() => { chrome.tabs.move = async () => { throw new Error('受控移动失败') } })
  await drag(page, row('普通二'), row('普通一'))
  await expect(page.getByRole('alert')).toContainText('无法调整标签页顺序')
  await expect.poll(order).toEqual(['待选 置顶二', '待选 置顶一', '待选 普通一', '待选 普通二'])
  await page.reload()
  await page.evaluate(async urls => {
    const [first] = await chrome.tabs.query({ url: urls[0] })
    const [last] = await chrome.tabs.query({ url: urls[1] })
    await chrome.tabs.move(last.id!, { index: first.index })
  }, tabs.slice(2).map(tab => tab.url()))
  await expect.poll(order).toEqual(['待选 置顶二', '待选 置顶一', '待选 普通二', '待选 普通一'])
  const browser = await page.evaluate(async () => (await chrome.tabs.query({ currentWindow: true })).filter(tab => tab.url?.includes('/web/')).map(tab => ({ title: tab.title, pinned: tab.pinned })))
  expect(browser).toEqual([{ title: '置顶二', pinned: true }, { title: '置顶一', pinned: true }, { title: '普通二', pinned: false }, { title: '普通一', pinned: false }])
  expect(tabs.every(tab => !tab.isClosed())).toBe(true)
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('link')).toHaveCount(0)
})

test('一键收藏后立即显示新块，即使当前空间已经滚动到底部', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await page.setViewportSize({ width: 1500, height: 650 })
  for (const title of ['一', '二', '三']) {
    await createCollection(page, title)
  }
  const viewport = page.getByRole('region', { name: '页面内容', exact: true })
  await viewport.hover()
  await page.mouse.wheel(0, 2000)
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(300)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/guide`)
  await expect(page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '一键收藏', exact: true }).click()
  await expect(page.getByRole('region', { name: /^收藏块 收藏 / })).toHaveCount(1)
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
  await expect(page.getByRole('region', { name: /^收藏块 收藏 / }).getByRole('link')).toBeInViewport()
})

for (const change of ['移动', '关闭', '置顶'] as const) test(`待选排序期间原标签被外部${change}时按浏览器实际状态结束`, async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const last = await context.newPage()
  await last.goto(`${origin}/web/guide`)
  const source = page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true })
  const target = page.getByRole('article', { name: '待选 React 文档', exact: true })
  await expect(source).toBeVisible()
  const from = (await source.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + 55, from.y + 25)
  await page.mouse.down()
  await page.mouse.move(to.x + 55, to.y + 25, { steps: 12 })
  await expect(page.locator('.tab-inbox [data-dragging]')).toHaveAttribute('data-dragging', 'true')
  await expect(page.getByRole('img', { name: '标签页放置位置', exact: true })).toHaveCount(0)
  await page.evaluate(async ({ url, change }) => {
    const [tab] = await chrome.tabs.query({ url })
    if (change === '关闭') await chrome.tabs.remove(tab.id!)
    else if (change === '置顶') await chrome.tabs.update(tab.id!, { pinned: true })
    else await chrome.tabs.move(tab.id!, { index: 0 })
  }, { url: last.url(), change })
  const browserOrder = () => page.evaluate(async () => {
    const owner = await chrome.tabs.getCurrent()
    return (await chrome.tabs.query({ windowId: owner!.windowId })).filter(tab => tab.url?.includes('/web/')).map(tab => ({ title: tab.title, pinned: tab.pinned }))
  })
  const actual = await browserOrder()
  await page.mouse.up()
  await expect(page.locator('.drag-preview')).toHaveCount(0)
  await expect.poll(browserOrder).toEqual(actual)
  await expect.poll(() => page.getByRole('complementary', { name: '待选网页' }).getByRole('article').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))).toEqual(actual.map(tab => `待选 ${tab.title}`))
  await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('link')).toHaveCount(0)
  expect(first.isClosed()).toBe(false)
})

test('键盘在置顶排序边界按上下键不会误入收藏区或关闭原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await createCollection(page, '边界下方的收藏目标')
  const pinned = await context.newPage()
  await pinned.goto(`${origin}/web/react`)
  const regular = await context.newPage()
  await regular.goto(`${origin}/web/guide`)
  await page.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url })
    await chrome.tabs.update(tab.id!, { pinned: true })
  }, pinned.url())
  await page.bringToFront()
  const source = page.getByRole('article', { name: '待选 React 文档', exact: true })
  for (const direction of ['ArrowDown', 'ArrowUp']) {
    await source.focus()
    await expect(source).toBeFocused()
    await source.press('Space', { delay: 100 })
    await expect(page.locator('.drag-preview')).toBeVisible()
    await page.keyboard.press(direction)
    await page.waitForTimeout(700)
    await page.keyboard.press('Space')
    await expect(page.locator('.drag-preview')).toHaveCount(0)
    expect(pinned.isClosed()).toBe(false)
    await expect(source).toBeVisible()
    await expect(page.getByRole('region', { name: /^收藏块/ }).getByRole('link')).toHaveCount(0)
  }
  expect(regular.isClosed()).toBe(false)
})

test('夸克修复先确认后重建已删除目录，保留本地收藏并恢复完整笔记', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, '修复后仍在的收藏')
  await newNote(page, context, '修复手记', '完整笔记正文')
  await sync(page)
  const sourceId = await page.evaluate(async () => (await chrome.storage.local.get<{ 'new-page.workspace.v1': StoredWorkspace }>('new-page.workspace.v1'))['new-page.workspace.v1'].active)
  expect(quark.published()).toHaveLength(1)
  expect(quark.notes()).toHaveLength(1)

  quark.files.clear()
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('同步未完成')
  await expect(page.getByRole('alert')).toContainText('收藏.json 已被移除')

  await page.getByRole('button', { name: '修复夸克同步', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修复夸克同步', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('页墟收藏')
  await expect(dialog).toContainText('本地')
  await expect(dialog).toContainText('笔记')
  expect(quark.files.size).toBe(0)
  await page.screenshot({ path: test.info().outputPath('quark-repair-confirm-desktop.png') })
  await page.setViewportSize({ width: 600, height: 850 })
  await expect(dialog).toBeVisible()
  const bounds = await dialog.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(600)
  await page.screenshot({ path: test.info().outputPath('quark-repair-confirm-narrow.png') })
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(quark.files.size).toBe(0)

  await page.getByRole('button', { name: '修复夸克同步', exact: true }).click()
  await dialog.getByRole('button', { name: '确认修复', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('status').first()).toHaveText('已同步')
  expect([...quark.files.values()].filter(file => file.parent === '0').map(file => file.name)).toEqual(['页墟收藏'])
  expect(quark.published()).toHaveLength(1)
  expect(quark.published()[0].body).toContain('修复后仍在的收藏')
  expect(quark.published()[0].body).toContain('完整笔记正文')
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].body.trim()).toBe('完整笔记正文')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: test.info().outputPath('quark-repair-complete.png') })
  await page.reload()
  await expect(page.getByRole('link', { name: '修复后仍在的收藏', exact: true })).toBeVisible()
  await expect(page.getByRole('article', { name: '笔记 修复手记', exact: true })).toBeVisible()
  expect(await page.evaluate(async () => (await chrome.storage.local.get<{ 'new-page.workspace.v1': StoredWorkspace }>('new-page.workspace.v1'))['new-page.workspace.v1'].active)).toBe(sourceId)
  await sync(page)
})

test('夸克普通同步不扫描 Markdown，编辑仅更新当前笔记且同名不冲突', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const first = await newNote(page, context, '同名手记', '第一篇完整正文')
  await newNote(page, context, '同名手记', '第二篇完整正文')
  await sync(page)
  expect(quark.notes()).toHaveLength(2)
  expect(new Set(quark.notes().map(file => file.name)).size).toBe(2)
  expect(quark.notes().map(file => file.body.trim()).sort()).toEqual(['第一篇完整正文', '第二篇完整正文'].sort())
  expect([...quark.files.values()].filter(file => file.parent === '0').map(file => file.name)).toEqual(['页墟收藏'])
  expect(quark.published()).toHaveLength(1)
  expect([...quark.files.values()].filter(file => file.parent === 'folder-rain').map(file => file.name).sort()).toEqual(['收藏.json', '笔记'].sort())
  const index = JSON.parse(quark.published()[0].body)
  expect(index.format).toBe('new-page')
  expect(Object.values(index.noteFiles).sort()).toEqual(quark.notes().map(file => `笔记/${file.name}`).sort())
  const currentFid = quark.published()[0].fid
  const other = quark.notes().find(file => file.body.trim() === '第二篇完整正文')!
  other.body = '云端手工改动，不由普通同步修复'
  const otherFid = other.fid
  const noteLists = quark.noteDirectoryLists
  const requests = quark.requests
  await sync(page)
  expect(quark.requests - requests).toBeLessThanOrEqual(3)
  expect(quark.noteDirectoryLists).toBe(noteLists)
  expect(quark.noteDownloadUrls).toBe(0)
  expect(quark.noteDownloads).toBe(0)
  expect(quark.files.get(otherFid)?.body).toBe('云端手工改动，不由普通同步修复')
  expect(quark.published()[0].fid).toBe(currentFid)
  expect(quark.snapshots()).toHaveLength(0)
  const noteUploads = quark.noteUploads
  await first.getByRole('textbox', { name: '笔记标题', exact: true }).fill('更名后的笔记')
  await first.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('更新后的正文')
  await expect(first.getByRole('status')).toContainText('已保存到本机')
  await sync(page)
  expect(quark.notes()).toHaveLength(2)
  expect(quark.notes().find(file => file.name.startsWith('更名后的笔记--'))?.body.trim()).toBe('更新后的正文')
  expect(quark.noteUploads - noteUploads).toBe(1)
  expect(quark.noteDownloadUrls).toBe(0)
  expect(quark.noteDownloads).toBe(0)
  expect(quark.files.get(otherFid)?.body).toBe('云端手工改动，不由普通同步修复')
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await page.getByRole('article', { name: '笔记 更名后的笔记', exact: true }).getByRole('button', { name: '删除笔记', exact: true }).click({ force: true })
  await sync(page)
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].fid).toBe(otherFid)
  expect(quark.notes()[0].body).toBe('云端手工改动，不由普通同步修复')
})

test('夸克发布重命名失败保留旧文件，重试可修复发布与清理', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)
  const note = await newNote(page, context, '失败恢复', '旧正文')
  await sync(page)
  const old = quark.notes()[0]
  const oldIndex = { ...quark.published()[0] }
  quark.failRename = true
  await note.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('新正文')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('同步未完成')
  expect(quark.files.get(old.fid)?.body.trim()).toBe('旧正文')
  expect(quark.published()).toEqual([oldIndex])
  expect(quark.snapshots()).toHaveLength(0)
  quark.failRename = false
  await sync(page)
  expect(quark.snapshots()).toHaveLength(0)
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].body.trim()).toBe('新正文')
  expect(quark.published()).toHaveLength(1)
  expect([...quark.files.values()].some(file => /^\.页墟/.test(file.name))).toBe(false)
  quark.failDelete = true
  await note.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('清理失败也保留的正文')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(page.getByRole('status').first()).toContainText('同步未完成')
  expect(quark.snapshots()).toHaveLength(0)
  quark.failDelete = false
  await sync(page)
  expect(quark.snapshots()).toHaveLength(0)
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].body.trim()).toBe('清理失败也保留的正文')
  expect([...quark.files.values()].some(file => /^\.页墟/.test(file.name))).toBe(false)
  expect(quark.noteDownloadUrls).toBe(0)
  expect(quark.noteDownloads).toBe(0)
})

test('夸克新建空笔记发布 Markdown，离线保存重启后补传并随父级删除恢复', async () => {
  test.setTimeout(90_000)
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  const opened = first.context.waitForEvent('page')
  await first.page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const note = await opened
  await expect(note.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveValue('新笔记')
  await sync(first.page)
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].name).toMatch(/^新笔记--[a-f0-9]{32}\.md$/)
  expect(quark.notes()[0].body.trim()).toBe('')
  quark.unavailable = true
  await note.getByRole('textbox', { name: '笔记标题', exact: true }).fill('离线补传的笔记')
  await note.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('重启后仍需补传的正文')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await first.page.getByRole('button', { name: '立即同步', exact: true }).click()
  await expect(first.page.getByRole('status').first()).toContainText('同步未完成')
  expect(quark.notes()[0].body.trim()).toBe('')
  await first.context.close()
  clients.splice(clients.findIndex(client => client.profile === first.profile), 1)
  const restarted = await openClient(first.profile, true)
  await expect(restarted.page.getByRole('link', { name: '离线补传的笔记', exact: true })).toBeVisible()
  quark.unavailable = false
  await sync(restarted.page)
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].body.trim()).toBe('重启后仍需补传的正文')
  expect(quark.notes()[0].name).toMatch(/^离线补传的笔记--[a-f0-9]{32}\.md$/)
  await restarted.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await restarted.page.getByRole('button', { name: '删除 日常收藏', exact: true }).click()
  await restarted.page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await sync(restarted.page)
  expect(quark.notes()).toHaveLength(0)
  await restarted.page.getByRole('button', { name: '回收站', exact: true }).click()
  await restarted.page.getByRole('button', { name: '恢复 日常收藏', exact: true }).click()
  await restarted.page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await sync(restarted.page)
  expect(quark.notes()).toHaveLength(1)
  expect(quark.notes()[0].body.trim()).toBe('重启后仍需补传的正文')
  expect(quark.noteDownloadUrls).toBe(0)
  expect(quark.noteDownloads).toBe(0)
})

test('夸克多次更新只保留当前文件，离线设备可合并且无变化同步只需三次请求', async () => {
  test.setTimeout(120_000)
  const first = await openClient(undefined, true)
  await connectQuark(first.page)
  await sync(first.page)
  const second = await openClient(undefined, true)
  await connectQuark(second.page)
  // The offline client's local merge baseline survives cloud replacements.
  await second.context.setOffline(true)
  for (let index = 0; index < 13; index++) {
    await first.page.getByRole('textbox', { name: '显示昵称', exact: true }).fill(`更新${index}`)
    await sync(first.page)
  }
  expect(quark.snapshots()).toHaveLength(0)
  expect(quark.published()).toHaveLength(1)
  const fid = quark.published()[0].fid
  const requests = quark.requests
  await sync(first.page)
  expect(quark.requests - requests).toBeLessThanOrEqual(3)
  expect(quark.published()[0].fid).toBe(fid)
  await second.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await addLink(second.page, '长期离线仍保留的链接')
  await second.context.setOffline(false)
  await sync(second.page)
  await sync(first.page)
  await first.page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(first.page.getByRole('link', { name: '长期离线仍保留的链接', exact: true })).toBeVisible()
  expect(quark.snapshots()).toHaveLength(0)
  expect(quark.published()).toHaveLength(1)
})

test('夸克确认当前收藏后清理旧同步历史，不读取历史也不删除其他文件', async () => {
  const { page } = await openClient(undefined, true)
  await connectQuark(page)
  await addLink(page, '清理历史仍保留的收藏')
  await sync(page)
  const currentFid = quark.published()[0].fid
  const account = 'rain', parent = 'folder-rain'
  quark.files.set('legacy-history', { fid: 'legacy-history', account, parent, name: '同步历史', directory: true, body: '' })
  quark.files.set('legacy-snapshot', { fid: 'legacy-snapshot', account, parent: 'legacy-history', name: `pg2-${'a'.repeat(32)}.json`, directory: false, body: '{obsolete, must not parse' })
  quark.files.set('legacy-root', { fid: 'legacy-root', account, parent, name: `pg1-${'b'.repeat(32)}.json`, directory: false, body: '{obsolete, must not parse' })
  quark.files.set('personal-file', { fid: 'personal-file', account, parent, name: '我的其他文件.json', directory: false, body: 'keep' })
  await sync(page)
  expect(quark.files.has('legacy-history')).toBe(false)
  expect(quark.snapshots()).toHaveLength(0)
  expect(quark.files.get('personal-file')?.body).toBe('keep')
  expect(quark.published()[0].fid).toBe(currentFid)
  expect(quark.published()[0].body).toContain('清理历史仍保留的收藏')
})

test('Chrome 分组：一键归组、原生同步编辑和解除保留原页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const second = await context.newPage()
  await second.goto(`${origin}/web/guide`)
  await page.evaluate(async url => {
    const [tab] = await chrome.tabs.query({ url })
    await chrome.tabs.update(tab.id!, { pinned: true })
  }, first.url())
  await page.bringToFront()
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(inbox.getByRole('article')).toHaveCount(2)
  await inbox.getByRole('button', { name: '一键分组', exact: true }).click()
  await expect(inbox.getByRole('button', { name: '编辑分组 分组1', exact: true })).toBeVisible()
  const grouped = await page.evaluate(async () => {
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    const tabs = await chrome.tabs.query({ currentWindow: true })
    return { groups, members: tabs.filter(tab => tab.groupId !== -1).map(tab => ({ title: tab.title, pinned: tab.pinned })) }
  })
  expect(grouped.groups.map(group => group.title)).toEqual(['分组1'])
  expect(grouped.members).toEqual([{ title: 'React 文档', pinned: false }, { title: 'UnoCSS 指南', pinned: false }])
  await inbox.getByRole('checkbox', { name: '选择 React 文档', exact: true }).check()
  await page.screenshot({ path: test.info().outputPath('groups-selection-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 480, height: 900 })
  await page.getByRole('button', { name: '打开待选网页', exact: true }).click()
  await page.screenshot({ path: test.info().outputPath('groups-selection-narrow.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(480)
  await page.setViewportSize({ width: 1500, height: 960 })
  await page.getByRole('button', { name: '取消选择', exact: true }).click()
  await inbox.getByRole('button', { name: '编辑分组 分组1', exact: true }).click()
  await page.getByRole('textbox', { name: '分组名称', exact: true }).fill('工作参考')
  await page.getByRole('button', { name: '保存分组', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })).map(group => group.title))).toEqual(['工作参考'])
  await page.evaluate(async () => {
    const [group] = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    await chrome.tabGroups.update(group.id, { title: '浏览器侧修改', color: 'purple' })
  })
  await expect(inbox.getByRole('button', { name: '编辑分组 浏览器侧修改', exact: true })).toBeVisible()
  await inbox.getByRole('button', { name: '解除分组 浏览器侧修改', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })).length)).toBe(0)
  expect(first.isClosed()).toBe(false)
  expect(second.isClosed()).toBe(false)
  await expect(inbox.getByRole('article')).toHaveCount(2)
})

test('批量收藏：跨收藏块选择链接和笔记并快速移入新收藏', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '归拢链接')
  const source = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await source.getByRole('button', { name: /加入(待办| Todo)/, exact: true }).click()
  const note = await newNote(page, context, '归拢笔记', '正文在跨块整理后仍保留')
  await page.bringToFront()
  await expect(page.getByRole('article', { name: '笔记 归拢笔记', exact: true })).toBeVisible()
  await createCollection(page, '另一个收藏块')
  await drag(page, source.getByRole('article', { name: '链接 归拢链接', exact: true }), page.getByRole('region', { name: '收藏块 另一个收藏块', exact: true }))
  await page.getByRole('checkbox', { name: '选择 归拢笔记', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择 归拢链接', exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await expect(toolbar).toContainText('2')
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 10, 14, 12, 5, 9).getTime()))
  await toolbar.getByRole('button', { name: '快速收藏', exact: true }).click()
  const collected = page.getByRole('region', { name: '收藏块 收藏 2026-11-14 12:05:09', exact: true })
  await expect(collected.getByRole('article')).toHaveCount(2)
  expect(await collected.getByRole('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(['笔记 归拢笔记', '链接 归拢链接'])
  await expect(collected.getByText('正文在跨块整理后仍保留', { exact: true })).toBeVisible()
  await expect(collected.getByRole('button', { name: /移出(待办| Todo)/, exact: true })).toBeVisible()
  await expect(source.getByRole('article')).toHaveCount(0)
  await expect(page.getByRole('region', { name: '收藏块 另一个收藏块', exact: true }).getByRole('article')).toHaveCount(0)
  await expect(toolbar).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await note.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('仍然是同一篇笔记')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await expect(collected.getByText('仍然是同一篇笔记', { exact: true })).toBeVisible()
  await page.reload()
  await expect(collected.getByRole('article')).toHaveCount(2)
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(page.getByRole('link', { name: '归拢链接', exact: true })).toBeVisible()
})

test('批量选择：Shift 范围、两侧互斥和 Escape 退出保持卡片布局', async () => {
  const { page, context } = await openClient()
  await connect(page)
  for (const title of ['选择一号', '选择二号', '选择三号']) await addLink(page, title)
  const cards = page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('article')
  const geometry = () => cards.evaluateAll(nodes => nodes.map(node => {
    const card = node.getBoundingClientRect()
    const title = node.querySelector('a')!.getBoundingClientRect()
    return { cardWidth: card.width, titleLeft: title.left, titleWidth: title.width }
  }))
  const before = await geometry()
  const first = page.getByRole('checkbox', { name: '选择 选择一号', exact: true })
  await first.hover()
  expect(await geometry()).toEqual(before)
  await first.check()
  await page.getByRole('checkbox', { name: '选择 选择三号', exact: true }).click({ modifiers: ['Shift'] })
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await expect(toolbar).toContainText('已选 3 项')
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(3)
  expect(await geometry()).toEqual(before)
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const second = await context.newPage()
  await second.goto(`${origin}/web/guide`)
  await page.bringToFront()
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  const checkbox = inbox.getByRole('checkbox', { name: '选择 React 文档', exact: true })
  await checkbox.check()
  await expect(cards.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await expect(toolbar).toContainText('已选 1 项')
  await expect(toolbar.getByRole('button', { name: '添加到对应收藏', exact: true })).toBeVisible()
  await toolbar.getByRole('button', { name: '全选', exact: true }).click()
  await expect(inbox.getByRole('checkbox', { checked: true })).toHaveCount(2)
  await checkbox.focus()
  await page.keyboard.press('Escape')
  await expect(toolbar).toHaveCount(0)
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await first.check()
  await expect(inbox.getByRole('checkbox', { checked: true })).toHaveCount(0)
  await page.getByRole('button', { name: /^Todo/ }).click()
  await expect(toolbar).toHaveCount(0)
  await expect(page.getByRole('checkbox')).toHaveCount(2)
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await first.check()
  await page.getByRole('button', { name: '搜索收藏', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await page.getByRole('searchbox', { name: '搜索全部收藏', exact: true }).fill('选择')
  await expect(page.getByRole('dialog').getByRole('article')).toHaveCount(3)
  await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(0)
})

test('Chrome 分组：编辑取消、九色、折叠和隐藏成员整组解除', async () => {
  const { page, context, url } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const second = await context.newPage()
  await second.goto(`${origin}/web/guide`)
  const hidden = await context.newPage()
  await hidden.goto(`${url}?hidden-member`)
  const groupId = await page.evaluate(async urls => {
    const ids: number[] = []
    for (const url of urls) ids.push((await chrome.tabs.query({ url }))[0].id!)
    const id = await chrome.tabs.group({ tabIds: [ids[0], ...ids.slice(1)] })
    await chrome.tabGroups.update(id, { title: '原生工作组', color: 'cyan' })
    return id
  }, [first.url(), second.url(), hidden.url()])
  await page.bringToFront()
  const group = page.getByRole('group', { name: '标签组 原生工作组', exact: true })
  await expect(group.getByRole('article')).toHaveCount(2)
  const edit = group.getByRole('button', { name: '编辑分组 原生工作组', exact: true })
  await edit.click()
  const editor = page.getByRole('dialog', { name: '编辑分组 原生工作组', exact: true })
  const name = editor.getByRole('textbox', { name: '分组名称', exact: true })
  await expect(editor.getByRole('group', { name: '分组颜色', exact: true }).getByRole('button')).toHaveCount(9)
  await name.fill('未提交的名称')
  await editor.getByRole('button', { name: '橙色', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(async id => { const group = await chrome.tabGroups.get(id); return { title: group.title, color: group.color } }, groupId)).toEqual({ title: '原生工作组', color: 'cyan' })
  await edit.click()
  await name.fill('')
  await editor.getByRole('button', { name: '保存分组', exact: true }).click()
  await expect(editor.getByRole('alert')).toContainText('分组名称')
  expect((await page.evaluate(id => chrome.tabGroups.get(id), groupId)).title).toBe('原生工作组')
  await name.fill('已提交的名称')
  await editor.getByRole('button', { name: '橙色', exact: true }).click()
  await name.press('Enter')
  await expect(editor).toHaveCount(0)
  expect(await page.evaluate(async id => { const group = await chrome.tabGroups.get(id); return { title: group.title, color: group.color } }, groupId)).toEqual({ title: '已提交的名称', color: 'orange' })
  const renamed = page.getByRole('group', { name: '标签组 已提交的名称', exact: true })
  await renamed.getByRole('button', { name: '折叠分组 已提交的名称', exact: true }).focus()
  await page.keyboard.press('Space')
  await expect.poll(() => page.evaluate(async id => (await chrome.tabGroups.get(id)).collapsed, groupId)).toBe(true)
  await expect(renamed.getByRole('article')).toHaveCount(0)
  await page.evaluate(id => chrome.tabGroups.update(id, { collapsed: false }), groupId)
  await expect(renamed.getByRole('article')).toHaveCount(2)
  await renamed.getByRole('button', { name: '解除分组 已提交的名称', exact: true }).click()
  await expect.poll(() => page.evaluate(async urls => (await chrome.tabs.query({ currentWindow: true })).filter(tab => urls.includes(tab.url!)).map(tab => tab.groupId), [first.url(), second.url(), hidden.url()])).toEqual([-1, -1, -1])
  expect([first, second, hidden].every(tab => !tab.isClosed())).toBe(true)
})

test('批量分组：收藏链接和笔记新开同一原生组且不复用已有页面', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '分组链接甲', `${origin}/web/react`)
  await addLink(page, '分组链接乙', `${origin}/web/react`)
  const editor = await newNote(page, context, '一起打开的笔记', '分组打开后原正文保持')
  const existing = await context.newPage()
  await existing.goto(`${origin}/web/react`)
  await page.bringToFront()
  for (const title of ['分组链接甲', '分组链接乙', '一起打开的笔记']) await page.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await toolbar.getByRole('button', { name: '分组', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  const actual = await page.evaluate(async ({ webUrl, noteUrl }) => {
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    const tabs = await chrome.tabs.query({ currentWindow: true })
    return {
      groups: groups.map(group => ({ title: group.title, members: tabs.filter(tab => tab.groupId === group.id).map(tab => tab.pendingUrl || tab.url).sort() })),
      webCount: tabs.filter(tab => (tab.pendingUrl || tab.url) === webUrl).length,
      noteCount: tabs.filter(tab => (tab.pendingUrl || tab.url) === noteUrl).length,
    }
  }, { webUrl: existing.url(), noteUrl: editor.url() })
  expect(actual).toEqual({ groups: [{ title: '分组1', members: [existing.url(), existing.url(), editor.url()].sort() }], webCount: 3, noteCount: 2 })
  const group = page.getByRole('group', { name: '标签组 分组1', exact: true })
  await expect(group.getByRole('article')).toHaveCount(2)
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('article')).toHaveCount(3)
  await expect(editor.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toContainText('分组打开后原正文保持')
  expect(existing.isClosed()).toBe(false)
})

test('批量删除：混合选择一次确认笔记永久删除而链接可恢复', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '可恢复的批量链接')
  const first = await newNote(page, context, '永久删除笔记甲', '甲正文')
  const second = await newNote(page, context, '永久删除笔记乙', '乙正文')
  await page.bringToFront()
  for (const title of ['可恢复的批量链接', '永久删除笔记甲', '永久删除笔记乙']) await page.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await toolbar.getByRole('button', { name: '删除', exact: true }).click()
  const confirmation = page.getByRole('dialog', { name: '删除所选内容', exact: true })
  await expect(confirmation).toContainText('永久删除 2 篇笔记')
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(toolbar).toContainText('已选 3 项')
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('article')).toHaveCount(3)
  await toolbar.getByRole('button', { name: '删除', exact: true }).click()
  await confirmation.getByRole('button', { name: '确认删除所选', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('article')).toHaveCount(0)
  for (const editor of [first, second]) {
    await expect(editor.getByRole('alert')).toContainText('永久删除')
    await expect(editor.getByRole('textbox', { name: '笔记标题', exact: true })).toHaveAttribute('readonly', '')
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(page.getByRole('button', { name: '恢复 可恢复的批量链接', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^恢复 永久删除笔记/ })).toHaveCount(0)
  await page.getByRole('button', { name: '恢复 可恢复的批量链接', exact: true }).click()
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('link', { name: '可恢复的批量链接', exact: true })).toBeVisible()
})

test('批量收藏：待选跨空间保存后仅重试失败关闭且不重复收藏', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await createSpace(page, '目标空间')
  await page.getByRole('button', { name: '目标空间', exact: true }).click()
  await createCollection(page, '目标收藏')
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const second = await context.newPage()
  await second.goto(`${origin}/web/guide`)
  await page.bringToFront()
  for (const title of ['React 文档', 'UnoCSS 指南']) await page.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  await page.evaluate(() => {
    const original = chrome.tabs.remove.bind(chrome.tabs) as (id: number) => Promise<void>
    let rejected = false
    chrome.tabs.remove = (async (id: number) => {
      if (!rejected && (await chrome.tabs.get(id)).title === 'React 文档') { rejected = true; throw new Error('受控第一次关闭失败') }
      return original(id)
    }) as typeof chrome.tabs.remove
  })
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await toolbar.getByRole('button', { name: '添加到对应收藏', exact: true }).click()
  const target = page.getByRole('dialog', { name: '添加到对应收藏', exact: true })
  await target.getByRole('combobox', { name: '空间', exact: true }).selectOption({ label: '目标空间' })
  await target.getByRole('combobox', { name: '收藏块', exact: true }).selectOption({ label: '目标收藏' })
  await target.getByRole('button', { name: '确认收藏', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('关闭未完成')
  await expect(toolbar).toContainText('已选 1 项')
  expect(first.isClosed()).toBe(false)
  await expect.poll(() => second.isClosed()).toBe(true)
  await toolbar.getByRole('button', { name: '快速收藏', exact: true }).click()
  await expect.poll(() => first.isClosed()).toBe(true)
  await expect(toolbar).toHaveCount(0)
  await expect(page.getByRole('region', { name: /^收藏块 收藏 / })).toHaveCount(0)
  await page.getByRole('button', { name: '目标空间', exact: true }).click()
  const saved = page.getByRole('region', { name: '收藏块 目标收藏', exact: true })
  await expect(saved.getByRole('link')).toHaveText(['React 文档', 'UnoCSS 指南'])
  await saved.getByRole('checkbox', { name: '选择 React 文档', exact: true }).check()
  await toolbar.getByRole('button', { name: '移动到收藏块', exact: true }).click()
  const moving = page.getByRole('dialog', { name: '移动到收藏块', exact: true })
  await expect(moving.getByRole('combobox', { name: '空间', exact: true }).getByRole('option')).toHaveText(['目标空间'])
  await moving.getByRole('button', { name: '取消', exact: true }).click()
  await expect(toolbar).toContainText('已选 1 项')
  await page.reload()
  await page.getByRole('button', { name: '目标空间', exact: true }).click()
  await expect(saved.getByRole('link')).toHaveText(['React 文档', 'UnoCSS 指南'])
})

test('待选排序与进出组仅使用占位反馈，组外末尾不提示移出分组', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const opened: Page[] = []
  for (const [index, title] of ['组内甲', '组内乙', '组外丙', '组外丁'].entries()) {
    const tab = await context.newPage()
    await tab.goto(`${origin}/web/react?feedback=${index}`)
    await tab.evaluate(title => { document.title = title }, title)
    opened.push(tab)
  }
  await page.evaluate(async urls => {
    const tabs = await Promise.all(urls.map(async url => (await chrome.tabs.query({ url }))[0]))
    const id = await chrome.tabs.group({ tabIds: [tabs[0].id!, ...tabs.slice(1).map(tab => tab.id!)] })
    await chrome.tabGroups.update(id, { title: '资料组', color: 'blue' })
  }, opened.slice(0, 2).map(tab => tab.url()))
  await page.bringToFront()
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  const source = inbox.getByRole('article', { name: '待选 组外丙', exact: true })
  const last = inbox.getByRole('article', { name: '待选 组外丁', exact: true })
  const from = (await source.boundingBox())!
  await page.mouse.move(from.x + 50, from.y + 20)
  await page.mouse.down()
  const tail = (await inbox.locator('[data-tab-slot="-1"]').last().boundingBox())!
  await page.mouse.move(tail.x + tail.width / 2, tail.y + tail.height / 2, { steps: 16 })
  await expect(page.locator('.drag-preview')).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('outside-tail-feedback.png') })
  await expect(inbox.getByText('移出分组', { exact: true })).toHaveCount(0)
  await expect(inbox.getByText(/^加入.*分组$/)).toHaveCount(0)
  await expect(inbox.getByRole('status', { name: '标签页放置位置', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(page.locator('.drag-preview')).toHaveCount(0)

  await source.click({ trial: true })
  const sortingFrom = (await source.boundingBox())!
  const target = (await last.boundingBox())!
  await page.mouse.move(sortingFrom.x + 50, sortingFrom.y + 20)
  await page.mouse.down()
  await page.mouse.move(target.x + 50, target.y + 20, { steps: 16 })
  await expect(source).toHaveAttribute('data-dragging', 'true')
  expect(await source.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('dashed')
  expect((await source.boundingBox())!.height).toBeCloseTo(from.height, 0)
  expect(await last.evaluate(node => getComputedStyle(node).outlineStyle)).toBe('none')
  await expect(last.getByRole('img', { name: '标签页放置位置', exact: true })).toHaveCount(0)
  await page.mouse.up()
  await expect.poll(() => page.evaluate(async () => (await chrome.tabs.query({ currentWindow: true }))
    .filter(tab => tab.title?.startsWith('组外')).map(tab => ({ title: tab.title, groupId: tab.groupId })))).toEqual([
      { title: '组外丁', groupId: -1 }, { title: '组外丙', groupId: -1 },
    ])

  const group = inbox.getByRole('group', { name: '标签组 资料组', exact: true })
  for (const direction of ['入组', '出组', '折叠组'] as const) {
    if (direction === '折叠组') await group.getByRole('button', { name: '折叠分组 资料组', exact: true }).click()
    const moving = direction === '出组' ? group.getByRole('article', { name: '待选 组内乙', exact: true }) : source
    const destination = direction === '出组' ? inbox.locator('[data-tab-slot="-1"]').last()
      : direction === '折叠组' ? group.locator('[data-drag-id]').first() : group.locator('[data-tab-slot]').last()
    await moving.click({ trial: true })
    const start = (await moving.boundingBox())!
    const end = (await destination.boundingBox())!
    await page.mouse.move(start.x + 50, start.y + 20)
    await page.mouse.down()
    await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 16 })
    await expect(moving).toHaveAttribute('data-dragging', 'true')
    const placeholder = direction === '出组' ? destination.getByRole('img', { name: '标签页占位', exact: true })
      : group.getByRole('img', { name: '标签页占位', exact: true })
    await expect(placeholder).toBeVisible()
    expect((await placeholder.boundingBox())!.height).toBeCloseTo(start.height, 0)
    expect(await moving.evaluate(node => getComputedStyle(node).position)).toBe('absolute')
    if (direction === '入组') {
      const second = group.getByRole('article', { name: '待选 组内乙', exact: true })
      const next = (await second.boundingBox())!
      await page.mouse.move(next.x + 50, next.y + next.height / 2, { steps: 10 })
      await expect(placeholder).toBeVisible()
      await expect.poll(async () => {
        const placed = (await placeholder.boundingBox())!
        const following = (await second.boundingBox())!
        return following.y - placed.y - placed.height
      }).toBeGreaterThanOrEqual(0)
      const first = group.getByRole('article', { name: '待选 组内甲', exact: true })
      const back = (await first.boundingBox())!
      await page.mouse.move(back.x + 50, back.y + back.height / 2, { steps: 10 })
      await expect(placeholder).toBeVisible()
      await expect.poll(async () => (await first.boundingBox())!.y - (await placeholder.boundingBox())!.y).toBeGreaterThan(start.height)
      const forward = (await second.boundingBox())!
      await page.mouse.move(forward.x + 50, forward.y + forward.height / 2, { steps: 10 })
      await expect.poll(async () => {
        const placed = (await placeholder.boundingBox())!
        const following = (await second.boundingBox())!
        return following.y - placed.y - placed.height
      }).toBeGreaterThanOrEqual(0)
    }
    await expect(inbox.getByText('移出分组', { exact: true })).toHaveCount(0)
    await expect(inbox.getByText(/^加入/)).toHaveCount(0)
    await expect(inbox.getByRole('status', { name: '标签页放置位置', exact: true })).toHaveCount(0)
    const samples = await destination.evaluate(async node => {
      const positions: number[] = []
      for (let frame = 0; frame < 30; frame++) {
        await new Promise(requestAnimationFrame)
        positions.push(node.getBoundingClientRect().top)
      }
      return positions.slice(-10)
    })
    expect(Math.max(...samples) - Math.min(...samples), `${direction}停留时落点不跳动`).toBeLessThan(1)
    await page.screenshot({ path: test.info().outputPath(`group-hover-${direction}.png`) })
    if (direction === '折叠组') await page.mouse.up()
    else { await page.keyboard.press('Escape'); await page.mouse.up() }
    await expect(page.locator('.drag-preview')).toHaveCount(0)
    if (direction !== '折叠组') {
      expect(await page.evaluate(async url => (await chrome.tabs.query({ url }))[0].groupId, opened[2].url())).toBe(-1)
    }
  }
  await expect(group.getByRole('button', { name: '展开分组 资料组', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(async urls => {
    const tabs = await Promise.all(urls.map(async url => (await chrome.tabs.query({ url }))[0]))
    return tabs[0].groupId !== -1 && tabs[0].groupId === tabs[1].groupId
  }, [opened[0].url(), opened[2].url()])).toBe(true)
})

test('Chrome 分组：标签拖入拖出、多选入组和完整组排序', async () => {
  const { page, context, url } = await openClient()
  await connect(page)
  const opened: Page[] = []
  for (const [index, title] of ['组内甲', '组内乙', '组外丙', '组外丁'].entries()) {
    const tab = await context.newPage()
    await tab.goto(`${origin}/web/react?drag=${index}`)
    await tab.evaluate(title => { document.title = title }, title)
    opened.push(tab)
  }
  const hidden = await context.newPage()
  await hidden.goto(`${url}?group-drag-hidden`)
  const ids = await page.evaluate(async urls => {
    const tabs = await Promise.all(urls.map(async url => (await chrome.tabs.query({ url }))[0]))
    const first = await chrome.tabs.group({ tabIds: [tabs[0].id!, tabs[1].id!] })
    await chrome.tabGroups.update(first, { title: '资料组', color: 'blue' })
    const second = await chrome.tabs.group({ tabIds: [tabs[3].id!, tabs[4].id!] })
    await chrome.tabGroups.update(second, { title: '目标组', color: 'green' })
    return { first, second }
  }, [...opened.map(tab => tab.url()), hidden.url()])
  await page.bringToFront()
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  const firstGroup = inbox.getByRole('group', { name: '标签组 资料组', exact: true })
  const secondGroup = inbox.getByRole('group', { name: '标签组 目标组', exact: true })
  await expect(firstGroup.getByRole('article')).toHaveCount(2)
  await drag(page, inbox.getByRole('article', { name: '待选 组外丙', exact: true }), firstGroup.locator('[data-tab-slot]').last())
  await expect(firstGroup.getByRole('article')).toHaveCount(3)
  await drag(page, firstGroup.getByRole('article', { name: '待选 组内乙', exact: true }), inbox.locator('[data-tab-slot="-1"]').last())
  await expect(firstGroup.getByRole('article')).toHaveCount(2)
  expect(await page.evaluate(async url => (await chrome.tabs.query({ url }))[0].groupId, opened[1].url())).toBe(-1)
  await drag(page, secondGroup.locator('[data-drag-id]').first(), inbox.locator('[data-tab-slot="-1"]').first())
  const groupOrder = await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    return groups.sort((a, b) => Math.min(...tabs.filter(tab => tab.groupId === a.id).map(tab => tab.index)) - Math.min(...tabs.filter(tab => tab.groupId === b.id).map(tab => tab.index))).map(group => group.title)
  })
  expect(groupOrder).toEqual(['目标组', '资料组'])
  expect(await page.evaluate(async url => (await chrome.tabs.query({ url }))[0].groupId, hidden.url())).toBe(ids.second)
  await firstGroup.getByRole('checkbox', { name: '选择 组内甲', exact: true }).check()
  await firstGroup.getByRole('checkbox', { name: '选择 组外丙', exact: true }).check()
  await drag(page, firstGroup.getByRole('article', { name: '待选 组内甲', exact: true }), secondGroup.locator('[data-tab-slot]').last())
  await expect(firstGroup).toHaveCount(0)
  await expect(secondGroup.getByRole('article')).toHaveCount(3)
  await expect(page.getByRole('toolbar', { name: '批量操作', exact: true })).toHaveCount(0)
  const members = await page.evaluate(async id => (await chrome.tabs.query({ groupId: id })).map(tab => tab.title), ids.second)
  expect(members).toEqual(['组外丁', await hidden.title(), '组内甲', '组外丙'])
})

test('一键收藏关闭失败后重试仅关闭已保存原页且不重复建块', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const second = await context.newPage()
  await second.goto(`${origin}/web/guide`)
  await page.bringToFront()
  await page.evaluate(() => {
    const original = chrome.tabs.remove.bind(chrome.tabs) as (id: number) => Promise<void>
    let rejected = false
    chrome.tabs.remove = (async (id: number) => {
      if (!rejected && (await chrome.tabs.get(id)).title === 'React 文档') { rejected = true; throw new Error('受控一键收藏关闭失败') }
      return original(id)
    }) as typeof chrome.tabs.remove
  })
  const collect = page.getByRole('button', { name: '一键收藏', exact: true })
  await collect.click()
  await expect.poll(() => second.isClosed()).toBe(true)
  expect(first.isClosed()).toBe(false)
  const blocks = page.getByRole('region', { name: /^收藏块 收藏 / })
  await expect(blocks).toHaveCount(1)
  await expect(blocks.getByRole('link')).toHaveText(['React 文档', 'UnoCSS 指南'])
  await collect.click()
  await expect.poll(() => first.isClosed()).toBe(true)
  await expect(blocks).toHaveCount(1)
  await expect(blocks.getByRole('link')).toHaveText(['React 文档', 'UnoCSS 指南'])
  await page.reload()
  await expect(blocks).toHaveCount(1)
  await expect(blocks.getByRole('link')).toHaveText(['React 文档', 'UnoCSS 指南'])
})

test('批量移动：混合卡片确认目标并整批拖回原收藏块保留次序', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '整批移动链接')
  const source = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await source.getByRole('button', { name: /加入(待办| Todo)/, exact: true }).click()
  const editor = await newNote(page, context, '整批移动笔记', '移动前后同一篇正文')
  await page.bringToFront()
  await createCollection(page, '批量移动目标')
  const destination = page.getByRole('region', { name: '收藏块 批量移动目标', exact: true })
  const order = await source.getByRole('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))
  for (const title of ['整批移动链接', '整批移动笔记']) await source.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await toolbar.getByRole('button', { name: '移动到收藏块', exact: true }).click()
  const target = page.getByRole('dialog', { name: '移动到收藏块', exact: true })
  await expect(target.getByRole('combobox', { name: '空间', exact: true }).getByRole('option')).toHaveText(['我的空间'])
  await target.getByRole('combobox', { name: '收藏块', exact: true }).selectOption({ label: '批量移动目标' })
  await target.getByRole('button', { name: '确认移动', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  await expect(source.getByRole('article')).toHaveCount(0)
  expect(await destination.getByRole('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(order)
  for (const title of ['整批移动链接', '整批移动笔记']) await destination.getByRole('checkbox', { name: `选择 ${title}`, exact: true }).check()
  await drag(page, destination.getByRole('article', { name: '笔记 整批移动笔记', exact: true }), source)
  await expect(toolbar).toHaveCount(0)
  await expect(destination.getByRole('article')).toHaveCount(0)
  expect(await source.getByRole('article').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')))).toEqual(order)
  await expect(source.getByRole('button', { name: /移出(待办| Todo)/, exact: true })).toBeVisible()
  await expect(source.getByText('移动前后同一篇正文', { exact: true })).toBeVisible()
  await editor.getByRole('textbox', { name: 'Markdown 正文', exact: true }).fill('移动之后仍能编辑原笔记')
  await expect(editor.getByRole('status')).toContainText('已保存到本机')
  await expect(source.getByText('移动之后仍能编辑原笔记', { exact: true })).toBeVisible()
  await page.reload()
  await expect(source.getByRole('article')).toHaveCount(2)
  await expect(destination.getByRole('article')).toHaveCount(0)
})

test('批量分组：原生命名失败保留选择并重试同组且只取消选中页置顶', async () => {
  const { page, context } = await openClient()
  await connect(page)
  const first = await context.newPage()
  await first.goto(`${origin}/web/react`)
  const second = await context.newPage()
  await second.goto(`${origin}/web/guide`)
  const untouched = await context.newPage()
  await untouched.goto(`${origin}/web/react?not-selected`)
  await untouched.evaluate(() => { document.title = '未选中的置顶页' })
  await page.evaluate(async urls => {
    for (const url of urls) await chrome.tabs.update((await chrome.tabs.query({ url }))[0].id!, { pinned: true })
    const original = chrome.tabGroups.update.bind(chrome.tabGroups)
    let rejected = false
    chrome.tabGroups.update = (async (id: number, properties: chrome.tabGroups.UpdateProperties) => {
      if (!rejected) { rejected = true; throw new Error('受控分组命名失败') }
      return original(id, properties)
    }) as typeof chrome.tabGroups.update
  }, [first.url(), untouched.url()])
  await page.bringToFront()
  await page.getByRole('checkbox', { name: '选择 React 文档', exact: true }).check()
  await page.getByRole('checkbox', { name: '选择 UnoCSS 指南', exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await toolbar.getByRole('button', { name: '分组', exact: true }).click()
  await expect(toolbar).toContainText('已选 2 项')
  const initial = await page.evaluate(() => chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }))
  expect(initial).toHaveLength(1)
  await toolbar.getByRole('button', { name: '分组', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  const groups = await page.evaluate(() => chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT }))
  expect(groups.map(group => ({ id: group.id, title: group.title }))).toEqual([{ id: initial[0].id, title: '分组1' }])
  const tabs = await page.evaluate(async urls => Promise.all(urls.map(async url => {
    const tab = (await chrome.tabs.query({ url }))[0]
    return { pinned: tab.pinned, groupId: tab.groupId }
  })), [first.url(), second.url(), untouched.url()])
  expect(tabs).toEqual([{ pinned: false, groupId: groups[0].id }, { pinned: false, groupId: groups[0].id }, { pinned: true, groupId: -1 }])
  expect([first, second, untouched].every(tab => !tab.isClosed())).toBe(true)
})

test('批量分组：新开收藏页重定向后失败重试仍分组且不重复打开或复用已有页', async () => {
  const { page, context } = await openClient()
  await connect(page)
  await addLink(page, '会重定向的收藏', `${origin}/web/react`)
  const existing = await context.newPage()
  await existing.goto(`${origin}/web/guide`)
  await page.bringToFront()
  await page.evaluate(redirectUrl => {
    const original = chrome.tabs.create.bind(chrome.tabs)
    const originalGroup = chrome.tabs.group.bind(chrome.tabs)
    let rejected = false
    chrome.tabs.group = (async (properties: chrome.tabs.GroupOptions) => {
      if (!rejected) { rejected = true; throw new Error('受控新页归组失败') }
      return originalGroup(properties)
    }) as typeof chrome.tabs.group
    chrome.tabs.create = (async (properties: chrome.tabs.CreateProperties) => {
      const created = await original(properties)
      await chrome.tabs.update(created.id!, { url: redirectUrl })
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await chrome.tabs.get(created.id!)
        if (current.url === redirectUrl && current.status === 'complete') return created
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      throw new Error('受控重定向没有完成')
    }) as typeof chrome.tabs.create
  }, `${origin}/web/guide`)
  await page.getByRole('checkbox', { name: '选择 会重定向的收藏', exact: true }).check()
  const toolbar = page.getByRole('toolbar', { name: '批量操作', exact: true })
  await toolbar.getByRole('button', { name: '分组', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(toolbar).toContainText('已选 1 项')
  expect(await page.evaluate(async guideUrl => (await chrome.tabs.query({ url: guideUrl })).length, existing.url())).toBe(2)
  await toolbar.getByRole('button', { name: '分组', exact: true }).click()
  await expect(toolbar).toHaveCount(0)
  const actual = await page.evaluate(async guideUrl => {
    const tabs = (await chrome.tabs.query({ currentWindow: true })).filter(tab => tab.url === guideUrl)
    const groups = await chrome.tabGroups.query({ windowId: chrome.windows.WINDOW_ID_CURRENT })
    return { pages: tabs.length, grouped: tabs.filter(tab => tab.groupId !== -1).length, ungrouped: tabs.filter(tab => tab.groupId === -1).length, groups: groups.map(group => group.title) }
  }, existing.url())
  expect(actual).toEqual({ pages: 2, grouped: 1, ungrouped: 1, groups: ['分组1'] })
  await expect(page.getByRole('region', { name: '收藏块 日常收藏', exact: true }).getByRole('link', { name: '会重定向的收藏', exact: true })).toHaveAttribute('href', `${origin}/web/react`)
  expect(existing.isClosed()).toBe(false)
})

test('笔记分享、防重复分享、管理修改与彻底删除', async () => {
  const { page, context } = await openClient()
  await connect(page)

  // Configure s.ee API key in Settings
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-share-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()

  // Intercept s.ee domains and text APIs
  let createdPayload: any = null
  let updatedPayload: any = null
  let deletedPayload: any = null

  await context.route('https://s.ee/api/v1/text/domains', route => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { domains: ['s.ee', 'fs.to'] } }),
    })
  })

  await context.route('https://s.ee/api/v1/text', async route => {
    const method = route.request().method()
    if (method === 'POST') {
      createdPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { slug: 'note-slug-1', short_url: `https://${createdPayload.domain}/note-slug-1` },
        }),
      })
    }
    if (method === 'PUT') {
      updatedPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success' }),
      })
    }
    if (method === 'DELETE') {
      deletedPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success' }),
      })
    }
    return route.fallback()
  })

  // Go to space
  await page.getByRole('button', { name: '我的空间', exact: true }).click()

  // Create a note
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const noteCard = page.getByRole('article', { name: '笔记 新笔记', exact: true })
  await expect(noteCard).toBeVisible()

  // Click share icon on note card
  await noteCard.getByRole('button', { name: '分享笔记', exact: true }).click()
  const shareDialog = page.getByRole('dialog', { name: '分享笔记', exact: true })
  await expect(shareDialog).toBeVisible()

  // Fill title, select domain, pick expiration preset
  await shareDialog.getByLabel('分享标题').fill('公开发布的测试笔记')
  const domainSelect = shareDialog.getByRole('combobox', { name: '分享域名', exact: true })
  await expect(domainSelect).toBeVisible()
  await domainSelect.click()
  const domainListbox = page.getByRole('listbox', { name: '分享域名' })
  await expect(domainListbox).toBeVisible()
  await domainListbox.getByRole('option', { name: 'fs.to', exact: true }).click()
  await expect(domainSelect).toContainText('fs.to')
  await shareDialog.getByRole('button', { name: '7天后', exact: true }).click()

  // Submit
  await shareDialog.getByRole('button', { name: '确认分享', exact: true }).click()
  await expect(shareDialog).not.toBeVisible()

  // Verify createdPayload
  expect(createdPayload).toMatchObject({
    title: '公开发布的测试笔记',
    domain: 'fs.to',
    text_type: 'markdown',
  })
  expect(createdPayload.tag_ids).toBeUndefined()
  expect(createdPayload.expire_at).toBeGreaterThan(0)

  // Card now shows active shared state (aria-label: 查看已分享短链)
  const sharedBtn = noteCard.getByRole('button', { name: '查看已分享短链', exact: true })
  await expect(sharedBtn).toBeVisible()

  // Clicking it opens already shared modal
  await sharedBtn.click()
  const alreadyDialog = page.getByRole('dialog', { name: '笔记已分享', exact: true })
  await expect(alreadyDialog).toBeVisible()
  await expect(alreadyDialog.getByRole('textbox')).toHaveValue('https://fs.to/note-slug-1')

  // Click "前往分享管理" in modal
  await alreadyDialog.getByRole('button', { name: '前往分享管理', exact: true }).click()
  await expect(alreadyDialog).not.toBeVisible()

  // Verify in Share Management page
  await expect(page.getByRole('heading', { name: '分享管理', exact: true })).toBeVisible()
  await expect(page.getByText('公开发布的测试笔记')).toBeVisible()
  await expect(page.getByText('https://fs.to/note-slug-1')).toBeVisible()

  // Edit share
  await page.getByRole('button', { name: '修改分享 公开发布的测试笔记', exact: true }).click()
  const editDialog = page.getByRole('dialog', { name: '修改分享内容', exact: true })
  await expect(editDialog).toBeVisible()
  await editDialog.getByLabel('分享标题').fill('修改后的测试笔记')
  await editDialog.getByRole('button', { name: '确认更新', exact: true }).click()
  await expect(editDialog).not.toBeVisible()

  expect(updatedPayload).toMatchObject({
    domain: 'fs.to',
    slug: 'note-slug-1',
    title: '修改后的测试笔记',
  })

  // Delete share
  await page.getByRole('button', { name: '删除分享 修改后的测试笔记', exact: true }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除分享', exact: true })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: '永久下线并删除', exact: true }).click()
  await expect(deleteDialog).not.toBeVisible()

  expect(deletedPayload).toEqual({
    domain: 'fs.to',
    slug: 'note-slug-1',
  })

  // Verify empty in share management
  await expect(page.getByText('暂无分享记录')).toBeVisible()

  // Return to space, note card restored to unshared
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(noteCard.getByRole('button', { name: '分享笔记', exact: true })).toBeVisible()
})

test('笔记分享：自定义短链与密码、原笔记删除后状态、远程下线失败本地容灾', async () => {
  const { page, context } = await openClient()
  await connect(page)

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-share-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()

  let postPayload: any = null
  let deleteAttempts = 0

  await context.route('https://s.ee/api/v1/text/domains', route => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { domains: ['s.ee', 'fs.to'] } }),
    })
  })

  await context.route('https://s.ee/api/v1/text', async route => {
    const method = route.request().method()
    if (method === 'POST') {
      postPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: {
            slug: postPayload.custom_slug || 'auto-slug',
            short_url: `https://${postPayload.domain}/${postPayload.custom_slug || 'auto-slug'}`,
          },
        }),
      })
    }
    if (method === 'DELETE') {
      deleteAttempts++
      if (deleteAttempts === 1) {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 's.ee server error' }),
        })
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 0 }) })
    }
    return route.fallback()
  })

  await page.getByRole('button', { name: '我的空间', exact: true }).click()

  // Create a note
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const normalCard = page.getByRole('article', { name: '笔记 新笔记', exact: true })
  await expect(normalCard).toBeVisible()

  await normalCard.getByRole('button', { name: '分享笔记', exact: true }).click()
  const shareDialog = page.getByRole('dialog', { name: '分享笔记', exact: true })
  await expect(shareDialog).toBeVisible()

  // Fill custom slug and password
  await shareDialog.getByLabel('分享标题').fill('高级配置分享')
  await shareDialog.getByRole('button', { name: '高级选项（自定义后缀与密码）', exact: true }).click()
  await shareDialog.getByLabel('自定义短链后缀（选填）').fill('my-secret-note')
  await shareDialog.getByLabel('访问密码（选填，3~32 位）').fill('pwd888888')
  await shareDialog.getByRole('button', { name: '确认分享', exact: true }).click()
  await expect(shareDialog).not.toBeVisible()

  expect(postPayload).toMatchObject({
    title: '高级配置分享',
    domain: 's.ee',
    custom_slug: 'my-secret-note',
    password: 'pwd888888',
  })

  // Delete the original note from space
  await normalCard.getByRole('button', { name: '删除笔记', exact: true }).click()
  await expect(normalCard).not.toBeVisible()

  // Navigate to share management
  await page.getByRole('button', { name: /分享管理/, exact: false }).click()
  await expect(page.getByRole('heading', { name: '分享管理', exact: true })).toBeVisible()

  // Verify badge "原笔记已删除"
  await expect(page.getByText('原笔记已删除')).toBeVisible()

  // Try edit
  await page.getByRole('button', { name: '修改分享 高级配置分享', exact: true }).click()
  const editDialog = page.getByRole('dialog', { name: '修改分享内容', exact: true })
  await expect(editDialog).toBeVisible()
  await expect(editDialog.getByText('原笔记已在收藏中被删除，无法获取最新正文更新远程分享。建议直接删除该失效分享。')).toBeVisible()
  await expect(editDialog.getByRole('button', { name: '确认更新', exact: true })).toBeDisabled()
  await editDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(editDialog).not.toBeVisible()

  // Delete share: first attempt fails on remote
  await page.getByRole('button', { name: '删除分享 高级配置分享', exact: true }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除分享', exact: true })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: '永久下线并删除', exact: true }).click()

  // Error shown, fallback button appeared
  await expect(deleteDialog.getByText('s.ee server error')).toBeVisible()
  const localRemoveBtn = deleteDialog.getByRole('button', { name: '仅从本地移除', exact: true })
  await expect(localRemoveBtn).toBeVisible()

  // Click local remove
  await localRemoveBtn.click()
  await expect(deleteDialog).not.toBeVisible()

  // Verify empty in share management
  await expect(page.getByText('暂无分享记录')).toBeVisible()
})

test('日期选择组件：点击任意位置弹出日历、不支持键盘输入、左右箭头与年月独立下拉、清除与日期图标互斥', async () => {
  const { page, context } = await openClient()
  await connect(page)

  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const noteCard = page.getByRole('article', { name: '笔记 新笔记', exact: true })
  await expect(noteCard).toBeVisible()

  await noteCard.getByRole('button', { name: '分享笔记', exact: true }).click()
  const shareDialog = page.getByRole('dialog', { name: '分享笔记', exact: true })
  await expect(shareDialog).toBeVisible()

  // 1. 点击指定日期 preset，展开自定义日期触发器与日历弹窗
  await shareDialog.getByRole('button', { name: '指定日期', exact: true }).click()

  const dateTrigger = shareDialog.getByRole('button', { name: '选择具体过期日期', exact: true })
  await expect(dateTrigger).toBeVisible()

  // 2. 确认不支持键盘手动输入：内部无 input 输入框
  await expect(dateTrigger.locator('input')).toHaveCount(0)

  // 3. 验证日历弹窗结构：左右尖括号箭头、年和月两个独立下拉框
  const calendarPopup = shareDialog.getByRole('dialog', { name: '日期选择日历', exact: true })
  await expect(calendarPopup).toBeVisible()

  const prevMonthBtn = calendarPopup.getByRole('button', { name: '上个月', exact: true })
  const nextMonthBtn = calendarPopup.getByRole('button', { name: '下个月', exact: true })
  const yearSelect = calendarPopup.getByRole('combobox', { name: '选择年份', exact: true })
  const monthSelect = calendarPopup.getByRole('combobox', { name: '选择月份', exact: true })

  await expect(prevMonthBtn).toBeVisible()
  await expect(nextMonthBtn).toBeVisible()
  await expect(yearSelect).toBeVisible()
  await expect(monthSelect).toBeVisible()

  // 验证下拉日历使用浮动定位，展开和收起不会撑高父容器
  const dialogBoxOpen = (await shareDialog.boundingBox())!
  await dateTrigger.click()
  await expect(calendarPopup).not.toBeVisible()
  const dialogBoxClosed = (await shareDialog.boundingBox())!
  expect(dialogBoxOpen.height).toBe(dialogBoxClosed.height)

  // 再次点击触发器任意位置可重新弹出日历
  await dateTrigger.click()
  await expect(calendarPopup).toBeVisible()

  // 验证年份和月份使用自定义下拉组件而非原生 select
  await yearSelect.click()
  const yearListbox = calendarPopup.getByRole('listbox', { name: '选择年份' })
  await expect(yearListbox).toBeVisible()
  const currentYear = new Date().getFullYear()
  await yearListbox.getByRole('option', { name: `${currentYear}年` }).click()
  await expect(yearListbox).not.toBeVisible()

  // 选定一个未来的日期（例如下个月的 15 号）
  await nextMonthBtn.click()
  const day15 = calendarPopup.getByRole('button', { name: /15日/, exact: false })
  await day15.click()

  // 选定后弹窗自动关闭
  await expect(calendarPopup).not.toBeVisible()

  // 触发器中显示选中的日期格式，且提示将在该日失效
  await expect(dateTrigger).toContainText('-15')
  await expect(shareDialog.getByText(/自动失效/)).toBeVisible()

  // 4. 清除图标与日期图标互斥显示：
  // 鼠标未 hover 时：无清除按钮，只有日历图标
  const clearBtn = dateTrigger.getByRole('button', { name: '清除日期', exact: true })
  await expect(clearBtn).not.toBeVisible()

  // 鼠标 hover 到日期选择框上：显示清除按钮
  await dateTrigger.hover()
  await expect(clearBtn).toBeVisible()

  // 点击清除按钮：重置为永久有效
  await clearBtn.click()
  await expect(shareDialog.getByRole('button', { name: '永久有效', exact: true })).toBeVisible()
  await expect(shareDialog.getByText(/自动失效/)).toHaveCount(0)

  // 清除后即使 hover 也不显示清除按钮
  await dateTrigger.hover()
  await expect(clearBtn).not.toBeVisible()

  // 验证点击弹窗内部空白区域（如 padding 内边距）不会误触发关闭
  await shareDialog.click({ position: { x: 10, y: 10 } })
  await expect(shareDialog).toBeVisible()

  // 点击外部遮罩区域则会正常关闭弹窗
  await page.mouse.click(5, 5)
  await expect(shareDialog).not.toBeVisible()
})

test('收藏块公开分享全流程：是否分享笔记开关、忽略未分享笔记、已分享防重及分享管理更新下线', async () => {
  const { page, context } = await openClient()
  await connect(page)

  // 1. 在设置中配置 s.ee API Key
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByLabel('s.ee API Key', { exact: true }).fill('see-collection-key')
  await page.getByRole('button', { name: '保存 s.ee API Key', exact: true }).click()
  await expect(page.getByText('s.ee API Key 已保存', { exact: true })).toBeVisible()

  // Mock s.ee 接口
  let createdPayload: any = null
  let updatedPayload: any = null
  let deletedPayload: any = null
  let createCount = 0

  await context.route('https://s.ee/api/v1/text/domains', route => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { domains: ['s.ee', 'fs.to'] } }),
    })
  })

  await context.route('https://s.ee/api/v1/text', async route => {
    const method = route.request().method()
    if (method === 'POST') {
      createCount++
      createdPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          code: 0,
          data: { slug: `slug-${createCount}`, short_url: `https://${createdPayload.domain}/slug-${createCount}` },
        }),
      })
    }
    if (method === 'PUT') {
      updatedPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success' }),
      })
    }
    if (method === 'DELETE') {
      deletedPayload = JSON.parse(route.request().postData() || '{}')
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 0, message: 'success' }),
      })
    }
    return route.fallback()
  })

  // 进入空间页面
  await page.getByRole('button', { name: '我的空间', exact: true }).click()

  // 2. 测试空收藏块的防空提交拦截
  await createCollection(page, '空白收藏块')

  // 点击空收藏块上的分享按钮
  await page.getByRole('button', { name: '分享 空白收藏块', exact: true }).click()
  const emptyShareDialog = page.getByRole('dialog', { name: '分享收藏块', exact: true })
  await expect(emptyShareDialog).toBeVisible()
  await expect(emptyShareDialog.getByText('当前收藏块没有可导出的有效卡片。')).toBeVisible()
  await expect(emptyShareDialog.getByRole('button', { name: '确认分享', exact: true })).toBeDisabled()
  await emptyShareDialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(emptyShareDialog).not.toBeVisible()

  // 3. 在「日常收藏」中创建链接和笔记并分享其中一篇笔记
  await addLink(page, 'React 文档')
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const note1Card = page.getByRole('article', { name: '笔记 新笔记', exact: true }).first()
  await expect(note1Card).toBeVisible()
  await note1Card.getByRole('button', { name: '分享笔记', exact: true }).click()
  const noteShareDialog = page.getByRole('dialog', { name: '分享笔记', exact: true })
  await noteShareDialog.getByLabel('分享标题').fill('已公开的参考笔记')
  await noteShareDialog.getByRole('button', { name: '确认分享', exact: true }).click()
  await expect(noteShareDialog).not.toBeVisible()

  // 再新建一篇不分享的笔记
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  await expect(page.getByRole('article', { name: '笔记 新笔记', exact: true })).toHaveCount(2)

  // 4. 对「日常收藏」发起收藏块分享
  await page.getByRole('button', { name: '分享 日常收藏', exact: true }).click()
  const colShareDialog = page.getByRole('dialog', { name: '分享收藏块', exact: true })
  await expect(colShareDialog).toBeVisible()

  // 检查首项为「是否分享笔记」开关，且默认关闭；此时未分享笔记提示不应出现
  const noteSwitch = colShareDialog.getByRole('switch', { name: '是否分享笔记', exact: true })
  await expect(noteSwitch).toBeVisible()
  await expect(noteSwitch).not.toBeChecked()
  await expect(colShareDialog.getByText(/未分享的笔记不会被包含/)).not.toBeVisible()

  // 开启「是否分享笔记」后，在合适时机展示未分享笔记过滤提示
  await noteSwitch.click()
  await expect(noteSwitch).toBeChecked()
  await expect(colShareDialog.getByText(/已并入 1 篇已公开笔记/)).toBeVisible()
  await expect(colShareDialog.getByText(/未分享的笔记不会被包含/)).toBeVisible()

  // 修改分享标题
  await colShareDialog.getByLabel('分享标题').fill('日常精选资源合集')

  // 确认分享提交
  await colShareDialog.getByRole('button', { name: '确认分享', exact: true }).click()
  await expect(colShareDialog).not.toBeVisible()

  // 验证 POST 发往 s.ee 的正文：不包含冗余标题，包含加粗链接与已分享笔记，不包含未分享笔记
  expect(createdPayload).toMatchObject({
    title: '日常精选资源合集',
    text_type: 'markdown',
  })
  expect(createdPayload.content).not.toContain('#')
  expect(createdPayload.content).toContain('https://s.ee/slug-1') // 已分享笔记短链
  expect(createdPayload.content).toContain('- **[React 文档]')
  expect(createdPayload.content).not.toContain('未公开')

  // 5. 校验收藏块工具栏变更为「已分享」状态，再次点击打开防重弹窗
  const sharedColBtn = page.getByRole('button', { name: '查看已分享短链 日常收藏', exact: true })
  await expect(sharedColBtn).toBeVisible()
  await sharedColBtn.click()

  const alreadyColDialog = page.getByRole('dialog', { name: '收藏块已分享', exact: true })
  await expect(alreadyColDialog).toBeVisible()
  await expect(alreadyColDialog.getByRole('textbox')).toHaveValue('https://s.ee/slug-2')

  // 点击「同步最新内容」按钮
  await alreadyColDialog.getByRole('button', { name: '同步最新内容', exact: true }).click()
  await expect(page.getByText('分享内容已同步更新')).toBeVisible()
  expect(updatedPayload).toMatchObject({
    title: '日常精选资源合集',
  })
  expect(updatedPayload.content).not.toContain('#')
  expect(updatedPayload.content).toContain('https://s.ee/slug-1')

  // 点击「前往分享管理」
  await alreadyColDialog.getByRole('button', { name: '前往分享管理', exact: true }).click()
  await expect(alreadyColDialog).not.toBeVisible()

  // 6. 验证在分享管理中的呈现与修改/删除
  await expect(page.getByRole('heading', { name: '分享管理', exact: true })).toBeVisible()
  // 检查收藏块分类选项卡
  const colTab = page.getByRole('button', { name: /收藏块\s*1/ })
  await expect(colTab).toBeVisible()
  await colTab.click()

  await expect(page.getByText('日常精选资源合集')).toBeVisible()
  await expect(page.getByText('含公开笔记')).toBeVisible()

  // 修改分享
  await page.getByRole('button', { name: '修改分享 日常精选资源合集', exact: true }).click()
  const editDialog = page.getByRole('dialog', { name: '修改分享内容', exact: true })
  await expect(editDialog).toBeVisible()
  await editDialog.getByLabel('分享标题').fill('更新后的日常精选合集')
  await editDialog.getByRole('button', { name: '确认更新', exact: true }).click()
  await expect(editDialog).not.toBeVisible()
  expect(updatedPayload.title).toBe('更新后的日常精选合集')

  // 删除分享（彻底下线）
  await page.getByRole('button', { name: '删除分享 更新后的日常精选合集', exact: true }).click()
  const deleteDialog = page.getByRole('dialog', { name: '删除分享', exact: true })
  await expect(deleteDialog).toBeVisible()
  await deleteDialog.getByRole('button', { name: '永久下线并删除', exact: true }).click()
  await expect(deleteDialog).not.toBeVisible()
  expect(deletedPayload.slug).toBe('slug-2')

  // 7. 回到空间，验证收藏块工具栏恢复为未分享状态
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await expect(page.getByRole('button', { name: '分享 日常收藏', exact: true })).toBeVisible()
})

test('文档页标签标题随收藏笔记、本地文件与在线 Markdown 动态同步与回退', async () => {
  const { page, context } = await openClient(undefined, true)
  await connectQuark(page)

  // 1. 收藏下的托管笔记：默认标题、实时编辑、空白回退、删除/恢复回退
  const openedNote = context.waitForEvent('page')
  await page.getByRole('button', { name: '新建笔记 日常收藏', exact: true }).click()
  const note = await openedNote
  const noteTitleInput = note.getByRole('textbox', { name: '笔记标题', exact: true })
  await expect(noteTitleInput).toHaveValue('新笔记')
  await expect(note).toHaveTitle('新笔记')

  await noteTitleInput.fill('周会纪要')
  await expect(note).toHaveTitle('周会纪要')

  await noteTitleInput.fill('   ')
  await expect(note).toHaveTitle('页墟 · Markdown')

  await noteTitleInput.fill('复盘纪要')
  await expect(note).toHaveTitle('复盘纪要')
  await expect(note.getByRole('status')).toContainText('已保存到本机')
  await note.reload()
  await expect(note).toHaveTitle('复盘纪要')

  await page.getByRole('button', { name: '删除 日常收藏', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '移到回收站', exact: true }).click()
  await expect(note.getByRole('alert')).toContainText('回收站')
  await expect(note).toHaveTitle('页墟 · Markdown')

  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await page.getByRole('button', { name: '恢复 日常收藏', exact: true }).click()
  await page.getByRole('dialog', { name: '回收站' }).getByRole('button', { name: '关闭弹窗' }).click()
  await expect(note).toHaveTitle('复盘纪要')

  // 2. 拖入本地 Markdown 文件
  const openedDropped = context.waitForEvent('page')
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(new File(['# 拖入标题\n\n本地正文'], '拖入手记.MD', { type: 'text/markdown' }))
    document.querySelector('.workbench')!.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
  })
  const droppedDoc = await openedDropped
  await expect(droppedDoc.getByRole('heading', { name: '拖入标题', exact: true })).toBeVisible()
  await expect(droppedDoc).toHaveTitle('拖入手记.MD')

  // 3. 在线 Markdown 文件：加载成功显示文件名，相对跳转同步更新，加载失败回退默认标题
  const remoteDoc = await context.newPage()
  const docBaseUrl = new URL('/document/index.html', page.url()).href
  await remoteDoc.goto(`${docBaseUrl}?url=${encodeURIComponent(`${origin}/markdown/guide.MD?version=1#安装`)}`)
  await expect(remoteDoc.getByRole('heading', { name: '阅读指南', exact: true })).toBeVisible()
  await expect(remoteDoc).toHaveTitle('guide.MD')

  await remoteDoc.getByRole('link', { name: '下一篇', exact: true }).click()
  await expect(remoteDoc.getByRole('heading', { name: '下一篇', exact: true })).toBeVisible()
  await expect(remoteDoc).toHaveTitle('next.md')

  await remoteDoc.goto(`${docBaseUrl}?url=${encodeURIComponent(`${origin}/markdown/error.md`)}`)
  await expect(remoteDoc.getByRole('alert')).toBeVisible()
  await expect(remoteDoc).toHaveTitle('页墟 · Markdown')

  // 4. 本地 file:// 目录文件：打开、切换文件与浏览器后退均同步文件名
  const { doc: localDoc, context: localContext } = await openFileDirectoryFixture()
  try {
    await expect(localDoc).toHaveTitle('当前文档.md')
    await localDoc.getByRole('button', { name: '文件目录', exact: true }).click()
    await localDoc.getByRole('button', { name: '打开 同级 #100%.MARKDOWN', exact: true }).click()
    await expect(localDoc.getByRole('heading', { name: '同级标题', exact: true })).toBeVisible()
    await expect(localDoc).toHaveTitle('同级 #100%.MARKDOWN')
    await localDoc.goBack()
    await expect(localDoc.getByRole('heading', { name: '当前标题', exact: true })).toBeVisible()
    await expect(localDoc).toHaveTitle('当前文档.md')
  } finally {
    await localContext.close()
  }
})
