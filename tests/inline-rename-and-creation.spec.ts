import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:https'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getTestCertificate } from './test-cert'
import { QuarkFixture } from './quark-fixture'

let server: Server
let origin: string
const files = new Map<string, { body: string; revision: number }>()
const clients: { context: BrowserContext; profile: string }[] = []
const quark = new QuarkFixture()

test.beforeAll(async () => {
  const cert = await getTestCertificate()
  server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
    if (await quark.handle(req, res, origin)) return
    if (req.headers.authorization !== `Basic ${Buffer.from('tester:secret').toString('base64')}`) {
      res.writeHead(401).end(); return
    }
    const path = new URL(req.url!, 'https://localhost').pathname
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
  const profile = await mkdtemp(join(tmpdir(), 'new-page-inline-e2e-'))
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
  await page.getByLabel('WebDAV 地址').fill(`${origin}/dav/`)
  await page.getByLabel('用户名', { exact: true }).fill('tester')
  await page.getByLabel('密码或应用专用密码').fill('secret')
  await page.getByRole('button', { name: /连接并开始|连接数据源/ }).click()
  if (!fromSettings && !onOnboarding) {
    await page.getByRole('button', { name: '我的空间' }).first().click()
  }
  await expect(page.getByRole('heading', { name: '我的空间', exact: true }).first()).toBeVisible()
}

test('收藏块去掉重命名图标按钮，双击名称进入行内编辑，Enter保存，删空恢复原名', async () => {
  const { page } = await openClient()
  await connect(page)

  const collection = page.getByRole('region', { name: '收藏块 日常收藏', exact: true })
  await expect(collection).toBeVisible()

  // 1. 图标按钮已去掉
  await expect(collection.getByRole('button', { name: /重命名/ })).toHaveCount(0)

  // 2. 悬停提示与双击名称进入行内编辑状态
  const titleHeading = collection.getByRole('heading', { name: '日常收藏', exact: true })
  await expect(titleHeading).toHaveAttribute('title', '双击重命名收藏块')
  await expect(titleHeading.locator('svg')).toHaveCount(1)
  await titleHeading.dblclick()

  const input = collection.getByRole('textbox', { name: '收藏块名称' })
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('日常收藏')
  await expect(collection.getByRole('button', { name: '确定', exact: true })).toBeVisible()
  await expect(collection.getByRole('button', { name: '取消', exact: true })).toBeVisible()

  // 3. 输入新名称并按回车确认保存
  await input.fill('生活精选')
  await input.press('Enter')

  await expect(input).toHaveCount(0)
  const updatedHeading = page.getByRole('region', { name: '收藏块 生活精选', exact: true }).getByRole('heading', { name: '生活精选', exact: true })
  await expect(updatedHeading).toBeVisible()

  // 4. 再次双击编辑，删空内容按 Enter，自动恢复为原名称（不保存空标题）
  await updatedHeading.dblclick()
  const editInput = page.getByRole('textbox', { name: '收藏块名称' })
  await expect(editInput).toBeVisible()
  await editInput.fill('')
  await editInput.press('Enter')

  await expect(editInput).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '生活精选', exact: true })).toBeVisible()
})

test('新建收藏块直接生成并进入行内编辑，点取消直接彻底删除（不入回收站）', async () => {
  const { page } = await openClient()
  await connect(page)

  // 1. 点击新建收藏块，不再弹框，直接在页面生成并处于编辑态
  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  const input = page.getByRole('textbox', { name: '收藏块名称' })
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('新收藏块')

  // 2. 点击取消按钮，该新建收藏块直接被彻底删除
  const cancelBtn = page.getByRole('button', { name: '取消', exact: true })
  await cancelBtn.click()

  await expect(input).toHaveCount(0)
  await expect(page.getByRole('region', { name: '收藏块 新收藏块' })).toHaveCount(0)

  // 3. 验证回收站内没有该碎片
  await page.getByRole('button', { name: '回收站', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '回收站' })).toBeVisible()
  await expect(page.getByText('回收站空空的')).toBeVisible()
})

test('新建收藏块输入有效名称点击确定成功保存', async () => {
  const { page } = await openClient()
  await connect(page)

  await page.getByRole('button', { name: '新建收藏块', exact: true }).click()
  const input = page.getByRole('textbox', { name: '收藏块名称' })
  await expect(input).toBeVisible()

  await input.fill('技术参考')
  const confirmBtn = page.getByRole('button', { name: '确定', exact: true })
  await confirmBtn.click()

  await expect(input).toHaveCount(0)
  await expect(page.getByRole('region', { name: '收藏块 技术参考', exact: true })).toBeVisible()
})

test('空间去掉重命名图标按钮，双击进入行内编辑，新建空间取消直接删除并恢复上一个空间', async () => {
  const { page } = await openClient()
  await connect(page)

  const spaceNav = page.getByRole('navigation', { name: '空间' })
  await expect(spaceNav.getByRole('button', { name: /重命名空间/ })).toHaveCount(0)

  // 悬停提示与双击空间按钮进入编辑
  const spaceBtn = spaceNav.getByRole('button', { name: '我的空间', exact: true })
  await expect(spaceBtn).toHaveAttribute('title', '我的空间 (双击重命名)')
  await expect(spaceBtn.locator('svg')).toHaveCount(2) // Folder 图标与悬停提示 Pencil 图标
  await spaceBtn.dblclick()

  const spaceInput = spaceNav.getByRole('textbox', { name: '空间名称' })
  await expect(spaceInput).toBeVisible()
  await expect(spaceInput).toHaveValue('我的空间')

  // 验证单行布局：行内编辑容器高度单行（小于 50px），输入框与确定/取消按钮处于同一水平行（垂直坐标差小于 10px）
  const editContainer = spaceNav.locator('.space-row').first()
  const box = await editContainer.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeLessThan(50)

  const inputBox = await spaceInput.boundingBox()
  const confirmBtn = spaceNav.getByRole('button', { name: '确定', exact: true })
  const confirmBox = await confirmBtn.boundingBox()
  expect(Math.abs(inputBox!.y - confirmBox!.y)).toBeLessThan(10)

  await spaceInput.fill('工作空间')
  await spaceInput.press('Enter')

  await expect(spaceInput).toHaveCount(0)
  await expect(spaceNav.getByRole('button', { name: '工作空间', exact: true })).toBeVisible()

  // 新建空间并取消
  await page.getByRole('button', { name: '新建空间', exact: true }).click()
  const newSpaceInput = spaceNav.getByRole('textbox', { name: '空间名称' })
  await expect(newSpaceInput).toBeVisible()
  await expect(newSpaceInput).toHaveValue('新空间')

  // 验证新建空间草稿也是单行布局
  const newEditContainer = spaceNav.locator('.space-row').first()
  const newBox = await newEditContainer.boundingBox()
  expect(newBox).not.toBeNull()
  expect(newBox!.height).toBeLessThan(50)

  // 点击取消
  const cancelSpaceBtn = spaceNav.getByRole('button', { name: '取消', exact: true })
  await cancelSpaceBtn.click()

  await expect(newSpaceInput).toHaveCount(0)
  await expect(spaceNav.getByRole('button', { name: '新空间' })).toHaveCount(0)
  // 恢复选中先前的空间
  await expect(page.getByRole('heading', { name: '工作空间', exact: true })).toBeVisible()
})
