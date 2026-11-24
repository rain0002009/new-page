import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:https'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getTestCertificate } from './test-cert'
import { QuarkFixture } from './quark-fixture'
import { active, apply, createDocument } from '../src/core/model'

let server: Server
let origin: string
const files = new Map<string, { body: string; revision: number }>()
const clients: { context: BrowserContext; profile: string }[] = []
const quark = new QuarkFixture()

test.beforeAll(async () => {
  const cert = await getTestCertificate()
  server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
    if (await quark.handle(req, res, origin)) return
    const path = new URL(req.url!, 'https://localhost').pathname
    if (path.startsWith('/web/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!DOCTYPE html><html><head><title>Web Page</title></head><body><h1>Web</h1></body></html>')
      return
    }
    if (req.headers.authorization !== `Basic ${Buffer.from('tester:secret').toString('base64')}`) {
      res.writeHead(401).end(); return
    }
    if (req.method === 'PROPFIND') { res.writeHead(207, { 'Content-Type': 'application/xml' }).end('<multistatus xmlns="DAV:"/>'); return }
    if (req.method === 'MKCOL') { res.writeHead(201).end(); return }
    const file = files.get(path)
    if (req.method === 'GET') {
      if (!file) { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"${file.revision}"` }).end(file.body)
      return
    }
    if (req.method === 'PUT') {
      if ((req.headers['if-none-match'] === '*' && file) ||
          (req.headers['if-match'] && req.headers['if-match'] !== `"${file?.revision}"`)) {
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

test.beforeEach(() => { files.clear(); quark.reset() })
test.afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.context.close()
    await rm(client.profile, { recursive: true, force: true })
  }
})
test.afterAll(async () => { await new Promise<void>(done => server.close(() => done())) })

async function openClient() {
  const profile = await mkdtemp(join(tmpdir(), 'new-page-open-col-e2e-'))
  const extension = join(profile, 'extension')
  await cp(resolve('dist/chrome'), extension, { recursive: true })
  const manifestPath = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.host_permissions = ['https://localhost/*', 'https://*.localhost/*', 'file:///*']
  await writeFile(manifestPath, JSON.stringify(manifest))

  const backgroundPath = join(extension, 'background/service_worker.js')
  let background = await readFile(backgroundPath, 'utf8')
  for (const host of ['https://drive-pc.quark.cn', 'https://uop.quark.cn', 'https://pan.quark.cn']) {
    background = background.replaceAll(host, origin)
  }
  background = background.replaceAll('https://s.ee', origin)
  await writeFile(backgroundPath, background)

  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    ignoreHTTPSErrors: true,
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
  return { context, page }
}

async function connect(page: Page) {
  await page.getByRole('button', { name: 'WebDAV', exact: true }).click()
  await page.getByLabel('昵称', { exact: true }).fill('Rain')
  await page.getByLabel('WebDAV 地址').fill(`${origin}/dav/`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: '连接并开始' }).click()
  await expect(page.getByRole('heading', { name: '我的空间', exact: true })).toBeVisible()
}

function seedCollectionData() {
  let doc = createDocument('Rain')
  const collection = active(doc).find(entity => entity.kind === 'collection')!
  doc = apply(doc, {
    type: 'add-links',
    parentId: collection.id,
    links: [
      { title: '测试链接', url: `${origin}/web/page1` },
    ],
  })
  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: 'note-open-1' })
  doc = apply(doc, {
    type: 'edit',
    id: 'note-open-1',
    patch: { title: '测试笔记', body: '# 笔记标题\n\n正文' },
  })
  files.set('/dav/new-page/data-v1.json', { body: JSON.stringify(doc), revision: 1 })
  return { doc, collectionId: collection.id }
}

test('收藏块包含切换并打开按钮，空内容时禁用；有内容时弹出载入收藏块弹窗并支持取消', async () => {
  const { page } = await openClient()
  await connect(page)

  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await expect(collection).toBeVisible()

  // 1. 空收藏块时按钮禁用
  const openBtn = collection.getByRole('button', { name: '切换并打开 日常收藏', exact: true })
  await expect(openBtn).toBeVisible()
  await expect(openBtn).toBeDisabled()

  // 2. 新建一条笔记使收藏块有内容
  await collection.getByRole('button', { name: '新建笔记 日常收藏' }).click()
  await expect(collection.getByRole('article', { name: /笔记/ })).toBeVisible()

  // 3. 按钮变为可用状态
  await expect(openBtn).toBeEnabled()

  // 4. 点击打开二次确认弹窗
  await openBtn.click()
  const dialog = page.getByRole('dialog', { name: '载入收藏块' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(/即将依次打开「日常收藏」/)).toBeVisible()

  // 5. 校验三个 radio 单选选项，默认选中「保留」
  const keepRadio = dialog.getByRole('radio', { name: '保留' })
  const groupRadio = dialog.getByRole('radio', { name: '收拢' })
  const clearRadio = dialog.getByRole('radio', { name: '清空' })

  await expect(keepRadio).toBeChecked()
  await expect(groupRadio).not.toBeChecked()
  await expect(clearRadio).not.toBeChecked()

  // 6. 点击取消关闭弹窗，页面无变化
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).not.toBeVisible()
})

test('选择「保留」确认后：原有标签保留，收藏块内的链接和笔记依次打开，且首个新标签激活聚焦', async () => {
  seedCollectionData()
  const { context, page } = await openClient()

  // 先打开一个独立页面作为现存标签页
  const existingPage = await context.newPage()
  await existingPage.goto(`${origin}/web/existing`)
  await page.bringToFront()

  await connect(page)

  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const openBtn = collection.getByRole('button', { name: '切换并打开 日常收藏', exact: true })
  await expect(openBtn).toBeEnabled()

  await openBtn.click()
  const dialog = page.getByRole('dialog', { name: '载入收藏块' })
  await expect(dialog).toBeVisible()

  // 点击确认（默认保留策略）
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(dialog).not.toBeVisible()

  // 校验标签页：现有页面、新打开的链接和笔记均存在（共 4 个页面：新标签页、existingPage、链接、笔记）
  await expect.poll(() => context.pages().length).toBe(4)

  const urls = context.pages().map(p => p.url())
  expect(urls.some(u => u.includes('/web/existing'))).toBe(true)
  expect(urls.some(u => u.includes('/web/page1'))).toBe(true)
  expect(urls.some(u => u.includes('/document/') && u.includes('note=note-open-1'))).toBe(true)

  // 校验激活标签页为第一个新打开的标签（测试链接）
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      return activeTab?.url
    })
  }).toContain('/web/page1')
})

test('选择「收拢」确认后：已有标签组折叠，散落未分组标签归入新折叠分组，新内容按序打开', async () => {
  seedCollectionData()
  const { context, page } = await openClient()

  // 打开两个独立页面作为普通散落标签
  const loose1 = await context.newPage()
  await loose1.goto(`${origin}/web/loose1`)
  const loose2 = await context.newPage()
  await loose2.goto(`${origin}/web/loose2`)
  await page.bringToFront()

  await connect(page)

  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const openBtn = collection.getByRole('button', { name: '切换并打开 日常收藏', exact: true })
  await openBtn.click()

  const dialog = page.getByRole('dialog', { name: '载入收藏块' })
  await dialog.getByRole('radio', { name: '收拢' }).click()
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(dialog).not.toBeVisible()

  // 校验新页面打开
  await expect.poll(() => context.pages().length).toBe(5)

  // 校验创建了一个折叠的标签组，名称为「分组1」
  await expect.poll(async () => {
    return await page.evaluate(async () => {
      const groups = await chrome.tabGroups.query({})
      return groups.map(g => ({ title: g.title, collapsed: g.collapsed }))
    })
  }).toEqual(expect.arrayContaining([{ title: '分组1', collapsed: true }]))
})

test('选择「清空」确认后：关闭原有散落标签，固定标签受保护，当前新标签页自动关闭，新内容打开并聚焦', async () => {
  seedCollectionData()
  const { context, page } = await openClient()

  // 打开一个普通页面和一个固定标签页
  const loosePage = await context.newPage()
  await loosePage.goto(`${origin}/web/loose`)

  const pinnedPage = await context.newPage()
  await pinnedPage.goto(`${origin}/web/pinned`)

  // 设置固定标签页
  await page.evaluate(async () => {
    const tabs = await chrome.tabs.query({ currentWindow: true })
    const pinned = tabs.find(t => t.url?.includes('/web/pinned'))
    if (pinned?.id) await chrome.tabs.update(pinned.id, { pinned: true })
  })

  await page.bringToFront()
  await connect(page)

  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  const openBtn = collection.getByRole('button', { name: '切换并打开 日常收藏', exact: true })
  await openBtn.click()

  const dialog = page.getByRole('dialog', { name: '载入收藏块' })
  await dialog.getByRole('radio', { name: '清空' }).click()
  await dialog.getByRole('button', { name: '确认' }).click()

  // 当前新标签页应自动关闭
  await expect.poll(() => page.isClosed()).toBe(true)

  // 校验剩余页面：固定页面保留、新打开的两个页面保留，loose 页面已关闭
  await expect.poll(() => context.pages().length).toBe(3)
  const remainingUrls = context.pages().map(p => p.url())
  expect(remainingUrls.some(u => u.includes('/web/pinned'))).toBe(true)
  expect(remainingUrls.some(u => u.includes('/web/page1'))).toBe(true)
  expect(remainingUrls.some(u => u.includes('note=note-open-1'))).toBe(true)
  expect(remainingUrls.some(u => u.includes('/web/loose'))).toBe(false)
})
