import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:https'
import { mkdtemp, rm, cp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { generate } from 'selfsigned'

let server: Server
let origin: string
let unavailable = false
let unsafeWrites = false
let rejectNextWrite = false
const files = new Map<string, { body: string; revision: number }>()
const clients: { context: BrowserContext; profile: string }[] = []

test.beforeAll(async () => {
  const cert = await generate([{ name: 'commonName', value: 'localhost' }], {
    extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }] }],
  })
  server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
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
      res.writeHead(200, { ETag: `"${file.revision}"`, 'Content-Type': 'application/json' }).end(file.body)
      return
    }
    if (req.method === 'PUT') {
      if (path.endsWith('/data-v1.json') && rejectNextWrite) { rejectNextWrite = false; res.writeHead(412).end(); return }
      if (!unsafeWrites && ((req.headers['if-none-match'] === '*' && file) ||
          (req.headers['if-match'] && req.headers['if-match'] !== `"${file?.revision}"`))) {
        res.writeHead(412).end(); return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      const revision = (file?.revision ?? 0) + 1
      files.set(path, { body, revision })
      res.writeHead(file ? 204 : 201, { ETag: `"${revision}"` }).end()
      return
    }
    if (req.method === 'DELETE') { files.delete(path); res.writeHead(204).end(); return }
    res.writeHead(405).end()
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  origin = `https://localhost:${(server.address() as { port: number }).port}`
})

test.beforeEach(() => { files.clear(); unavailable = false; unsafeWrites = false; rejectNextWrite = false })
test.afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.context.close()
    await rm(client.profile, { recursive: true, force: true })
  }
})
test.afterAll(async () => { await new Promise<void>(done => server.close(() => done())) })

async function openClient(existingProfile?: string) {
  const profile = existingProfile ?? await mkdtemp(join(tmpdir(), 'new-page-e2e-'))
  const extension = join(profile, 'extension')
  await cp(resolve('dist/chrome'), extension, { recursive: true })
  const manifestPath = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  // Pre-authorize only the isolated test server; production still requests its optional origin.
  manifest.host_permissions = ['https://localhost/*']
  await writeFile(manifestPath, JSON.stringify(manifest))
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
  return { context, page, profile, url: page.url() }
}

async function connect(page: Page, path = '/dav/') {
  await page.getByLabel('昵称', { exact: true }).fill('Rain')
  await page.getByLabel('WebDAV 地址').fill(`${origin}${path}`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: '连接并开始' }).click()
  await expect(page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
}

async function addLink(page: Page, title: string, url = 'https://react.dev/') {
  await page.getByRole('button', { name: '添加链接', exact: true }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('网址', { exact: true }).fill(url)
  await dialog.getByLabel('标题', { exact: true }).fill(title)
  await dialog.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByRole('link', { name: title, exact: true })).toBeVisible()
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
  await page.getByRole('searchbox', { name: '搜索全部收藏' }).fill('并发渲染')
  await expect(page.getByRole('link', { name: 'React 参考', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '定位收藏', exact: true }).click()
  await expect(page.getByRole('heading', { name: '工作', exact: true })).toBeVisible()
  await expect(page.getByText('并发渲染的备忘', { exact: true })).toBeVisible()
})

test('待选网页拖入即收藏，保留原页，并可批量收藏和移入折叠空块', async () => {
  const { page, context } = await openClient()
  const tab = await context.newPage()
  await tab.goto(`${origin}/web/react`)
  const guide = await context.newPage()
  await guide.goto(`${origin}/web/guide`)
  await connect(page)
  const inbox = page.getByRole('complementary', { name: '待选网页' })
  await expect(inbox.getByText('React 文档', { exact: true })).toBeVisible()
  await inbox.getByRole('article', { name: '待选 React 文档' }).dragTo(page.getByRole('region', { name: '收藏块 日常收藏' }))
  await expect(page.getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(tab.isClosed()).toBe(false)
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('稍后阅读')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: '折叠 稍后阅读', exact: true }).click()
  await page.getByRole('article', { name: '链接 React 文档', exact: true }).dragTo(page.getByRole('region', { name: '收藏块 稍后阅读' }))
  await expect(page.getByRole('region', { name: '收藏块 稍后阅读' }).getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await inbox.getByRole('button', { name: '收藏当前窗口', exact: true }).click()
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(1)
  await page.getByRole('dialog').getByLabel('名称').fill('今天的网页')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  const batch = page.getByRole('region', { name: '收藏块 今天的网页' })
  await expect(batch.getByRole('link', { name: 'React 文档', exact: true })).toBeVisible()
  await expect(batch.getByRole('link', { name: 'UnoCSS 指南', exact: true })).toBeVisible()
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
  await page.getByRole('article', { name: '链接 排在前面', exact: true }).dragTo(page.getByRole('article', { name: '链接 排在后面', exact: true }))
  await expect(page.getByRole('region', { name: '收藏块 日常收藏' }).getByRole('link').first()).toHaveText('排在前面')
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('优先阅读')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await page.getByLabel('拖动排序 优先阅读', { exact: true }).dragTo(page.getByLabel('拖动排序 日常收藏', { exact: true }))
  await expect(page.getByRole('region', { name: /^收藏块/ }).first()).toHaveAccessibleName('收藏块 优先阅读')
  await page.getByRole('button', { name: '新建空间', exact: true }).click()
  await page.getByRole('dialog').getByLabel('名称').fill('灵感')
  await page.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click()
  await page.getByRole('button', { name: '灵感', exact: true }).dragTo(page.getByRole('button', { name: '我的空间', exact: true }))
  await page.reload()
  await expect(page.getByRole('heading', { name: '灵感', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await page.getByRole('article', { name: '链接 排在前面', exact: true }).dragTo(page.getByRole('button', { name: '灵感', exact: true }))
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
  await page.getByRole('article', { name: '待选 UnoCSS 指南', exact: true }).dragTo(collection)
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
