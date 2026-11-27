import { createServer, type Server } from 'node:https'
import { mkdtemp, cp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { zipSync, strToU8 } from 'fflate'
import { getTestCertificate } from './test-cert'
import { QuarkFixture } from './quark-fixture'

let server: Server
let origin: string
const quark = new QuarkFixture()
const clients: { context: BrowserContext; profile: string }[] = []

function makeTestEpub(options?: { title?: string; longChapter?: boolean }) {
  const title = options?.title ?? '沙丘编年史'
  const longPara = options?.longChapter
    ? Array.from({ length: 40 }, (_, i) => `<p>第 ${i + 1} 段长篇正文内容，用于测试纵向滚动阅读器、字体大小、字重与行高样式以及滚动进度自动保存。</p>`).join('')
    : '<p>简短正文</p>'
  // 1x1 PNG
  const pngBytes = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
    8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192,
    80, 15, 0, 4, 133, 1, 128, 132, 169, 140, 194, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
  ])

  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0" encoding="utf-8"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>${title}</dc:title>
          <dc:creator>测试作者</dc:creator>
        </metadata>
        <manifest>
          <item id="ch1" href="Text/ch1.xhtml" media-type="application/xhtml+xml"/>
          <item id="ch2" href="Text/ch2.xhtml" media-type="application/xhtml+xml"/>
          <item id="img1" href="Images/cover.png" media-type="image/png"/>
          <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
        </manifest>
        <spine>
          <itemref idref="ch1"/>
          <itemref idref="ch2"/>
        </spine>
      </package>`,
    ),
    'OEBPS/Text/ch1.xhtml': strToU8(
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章 初见</h1><img src="../Images/cover.png" alt="封面"/>${longPara}</body></html>`,
    ),
    'OEBPS/Text/ch2.xhtml': strToU8(
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="part2">第二章 深入</h1>${longPara}<h2 id="sub2">2.2 深入后半</h2>${longPara}</body></html>`,
    ),
    'OEBPS/Images/cover.png': pngBytes,
    'OEBPS/nav.xhtml': strToU8(
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="Text/ch1.xhtml">第一章 初见</a></li><li><a href="Text/ch2.xhtml#part2">第二章 深入</a><ol><li><a href="Text/ch2.xhtml#part2">2.1 深入前半</a></li><li><a href="Text/ch2.xhtml#sub2">2.2 深入后半</a></li></ol></li></ol></nav></body></html>`,
    ),
  })
}

test.beforeAll(async () => {
  const cert = await getTestCertificate()
  server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
    if (await quark.handle(req, res, origin)) return
    res.writeHead(404).end()
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  origin = `https://localhost:${(server.address() as { port: number }).port}`
})

test.beforeEach(() => {
  quark.reset()
})

test.afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.context.close()
    await rm(client.profile, { recursive: true, force: true })
  }
})

test.afterAll(async () => {
  await new Promise<void>(done => server.close(() => done()))
})

async function openExtensionClient() {
  const profile = await mkdtemp(join(tmpdir(), 'new-page-epub-e2e-'))
  const extension = join(profile, 'extension')
  await cp(resolve('dist/chrome'), extension, { recursive: true })

  const manifestPath = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.host_permissions = ['https://localhost/*', 'https://*.localhost/*', 'file:///*']
  await writeFile(manifestPath, JSON.stringify(manifest))

  const patchUrls = (code: string) => {
    let next = code
    for (const host of ['https://drive-pc.quark.cn', 'https://uop.quark.cn', 'https://pan.quark.cn']) {
      next = next.replaceAll(host, origin)
    }
    return next
      .replaceAll('https://*.quark.cn/*', 'https://localhost/*')
      .replaceAll('https://*.uc.cn/*', 'https://localhost/*')
      .replaceAll('https://*.aliyuncs.com/*', 'https://*.localhost/*')
  }

  for (const rel of ['background/service_worker.js', 'chrome_url_overrides/newtab.js', 'shared/commons.js']) {
    const filePath = join(extension, rel)
    const content = await readFile(filePath, 'utf8').catch(() => null)
    if (content) await writeFile(filePath, patchUrls(content))
  }

  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1440, height: 920 },
    args: ['--enable-unsafe-extension-debugging', '--ignore-certificate-errors'],
  })
  clients.push({ context, profile })
  const session = await context.browser()!.newBrowserCDPSession()
  const { id } = await session.send('Extensions.loadUnpacked', { path: extension })
  const startupPages = context.pages()
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/chrome_url_overrides/newtab.html`)
  for (const startup of startupPages) await startup.close()
  await expect(page.getByRole('heading', { name: '我的空间' })).toBeVisible()
  return { context, page, extensionId: id }
}

async function dropEpubOnCollection(page: Page, collectionTitle: string, fileName: string, bytes: Uint8Array) {
  const collection = page.getByRole('region', { name: `收藏块 ${collectionTitle}` })
  await collection.evaluate((el, payload) => {
    const dt = new DataTransfer()
    const file = new File([new Uint8Array(payload.bytes)], payload.fileName, { type: 'application/epub+zip' })
    dt.items.add(file)
    el.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }))
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
  }, { fileName, bytes: Array.from(bytes) })
}

test('拖入本地 EPUB 弹窗记住选择、设置页修改、卡片样式标签共存与单本直删', async () => {
  const { page } = await openExtensionClient()
  const epub1 = makeTestEpub({ title: '沙丘编年史' })
  const epub2 = makeTestEpub({ title: '基地前奏' })
  const epub3 = makeTestEpub({ title: '银河帝国' })

  await dropEpubOnCollection(page, '日常收藏', 'dune.epub', epub1)
  const modal = page.getByRole('dialog', { name: '选择电子书保存与阅读方式' })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('radio', { name: /上传到夸克网盘/ })).toBeDisabled()
  await modal.getByLabel('记住我的选择，下次不再询问（可在设置中修改）').check()
  await modal.getByRole('button', { name: '确认添加' }).click()
  await expect(modal).toBeHidden()

  const card1 = page.locator('article[aria-label="电子书 沙丘编年史"]')
  await expect(card1).toBeVisible()
  await expect(card1.getByRole('progressbar', { name: '阅读进度' })).toHaveAttribute('aria-valuenow', '0')
  await expect(card1).toContainText('0%')

  // 验证背景色不同于链接卡(#eaf0e2)与笔记卡(#f2e6cc)，为淡青灰 #e4ecf2
  const rgb = await card1.evaluate(el => {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = getComputedStyle(el).backgroundColor
    ctx.fillRect(0, 0, 1, 1)
    return Array.from(ctx.getImageData(0, 0, 1, 1).data.slice(0, 3))
  })
  expect(rgb).toEqual([228, 236, 242])

  // 已记住选择，第二次拖入不弹窗直接生成卡片
  await dropEpubOnCollection(page, '日常收藏', 'prelude.epub', epub2)
  await expect(page.locator('article[aria-label="电子书 基地前奏"]')).toBeVisible()
  await expect(page.getByRole('dialog', { name: '选择电子书保存与阅读方式' })).toBeHidden()

  // 打标签后进度条仍旧显示
  await page.getByRole('button', { name: '更多操作 沙丘编年史' }).click()
  await page.getByRole('menuitem', { name: '标签' }).hover()
  const picker = page.getByRole('dialog', { name: '标签管理' })
  await picker.getByLabel('搜索或创建标签').fill('科幻')
  await picker.getByLabel('搜索或创建标签').press('Enter')
  await page.keyboard.press('Escape')
  await expect(card1).toContainText('科幻')
  await expect(card1.getByRole('progressbar', { name: '阅读进度' })).toBeVisible()

  // 前往设置页改回「每次询问」
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const epubPref = page.getByRole('combobox', { name: '拖入本地 EPUB 时' })
  await expect(epubPref).toContainText('本地直接阅读')
  await epubPref.click()
  await page.getByRole('option', { name: '每次询问' }).click()
  await expect(epubPref).toContainText('每次询问')

  // 返回空间再拖入应重新弹窗
  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  await dropEpubOnCollection(page, '日常收藏', 'empire.epub', epub3)
  await expect(page.getByRole('dialog', { name: '选择电子书保存与阅读方式' })).toBeVisible()
  await page.getByRole('button', { name: '取消' }).click()

  // 单本删除直接永久清除（不入回收站）且清理 IndexedDB
  await page.getByRole('button', { name: '更多操作 基地前奏' }).click()
  await page.getByRole('menuitem', { name: '删除电子书' }).click()
  await expect(page.locator('article[aria-label="电子书 基地前奏"]')).toBeHidden()
  await page.getByRole('button', { name: /回收站/ }).click()
  await expect(page.getByRole('dialog', { name: '回收站' })).not.toContainText('基地前奏')
  await page.keyboard.press('Escape')

  const remainingKeys = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('page-garden-epubs', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return await new Promise<IDBValidKey[]>(resolve => {
      const req = db.transaction('books', 'readonly').objectStore('books').getAllKeys()
      req.onsuccess = () => { db.close(); resolve(req.result) }
    })
  })
  expect(remainingKeys).toHaveLength(1)
})

test('单击进入无流体动画左右分栏阅读页、多级目录折叠与子章跳转、无滚动条分页滚轮翻页及进度写回', async () => {
  const { context, page } = await openExtensionClient()
  const epub = makeTestEpub({ title: '风之名', longChapter: true })

  await dropEpubOnCollection(page, '日常收藏', 'name-of-wind.epub', epub)
  const modal = page.getByRole('dialog', { name: '选择电子书保存与阅读方式' })
  await modal.getByRole('button', { name: '确认添加' }).click()

  const card = page.locator('article[aria-label="电子书 风之名"]')
  await expect(card).toBeVisible()

  const [readerPage] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('link', { name: '风之名' }).click(),
  ])
  await readerPage.waitForLoadState('domcontentloaded')

  // 无流体动画 canvas，且整页无滚动条、右侧占满剩余宽度
  await expect(readerPage.locator('canvas')).toHaveCount(0)
  const sidebar = readerPage.getByRole('complementary', { name: '阅读器侧栏' })
  const mainArea = readerPage.getByRole('main', { name: '阅读主区域' })
  await expect(sidebar).toBeVisible()
  await expect(mainArea).toBeVisible()

  const layoutMetrics = await readerPage.evaluate(() => ({
    docScrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
    mainRight: document.querySelector('main')!.getBoundingClientRect().right,
    winW: window.innerWidth,
  }))
  expect(layoutMetrics.docScrollH).toBeLessThanOrEqual(layoutMetrics.winH)
  expect(layoutMetrics.mainRight).toBeGreaterThanOrEqual(layoutMetrics.winW - 2)

  // 内嵌图片正常还原渲染
  const img = readerPage.locator('[data-reader-body] img')
  await expect(img).toBeVisible()
  expect(await img.getAttribute('src')).toMatch(/^blob:/)

  // 调节字号、字重、行高、分栏（单栏/双栏）与关闭翻页动画
  const fontSizeInput = readerPage.getByLabel('字体大小')
  await fontSizeInput.fill('22')
  await fontSizeInput.dispatchEvent('change')
  await readerPage.getByRole('button', { name: '半粗' }).click()
  const lineHeightInput = readerPage.getByLabel('行高')
  await lineHeightInput.fill('2')
  await lineHeightInput.dispatchEvent('change')
  await expect(readerPage.getByRole('button', { name: '单栏' })).toHaveAttribute('aria-pressed', 'true')
  await readerPage.getByRole('button', { name: '双栏' }).click()
  await expect(readerPage.getByRole('button', { name: '双栏' })).toHaveAttribute('aria-pressed', 'true')
  await readerPage.getByRole('switch', { name: '翻页动画' }).click()

  const bodyStyles = await readerPage.locator('[data-reader-body]').evaluate(el => {
    const cs = getComputedStyle(el)
    return { fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, transitionProperty: cs.transitionProperty }
  })
  expect(bodyStyles.fontSize).toBe('22px')
  expect(bodyStyles.fontWeight).toBe('600')
  expect(parseFloat(bodyStyles.lineHeight)).toBeCloseTo(44, 0)
  expect(bodyStyles.transitionProperty).toBe('none')

  // 滚轮向下触发翻页（关闭动画后同章翻页也无过渡动画），并简易显示当前页码
  const pageIndicator = readerPage.getByLabel('页码')
  await expect(pageIndicator).toContainText('第 1 /')
  const mainBox = (await mainArea.boundingBox())!
  await readerPage.mouse.move(mainBox.x + mainBox.width / 2, mainBox.y + mainBox.height / 2)
  await readerPage.mouse.wheel(0, 240)
  await expect(pageIndicator).toContainText('第 2 /')
  expect(await readerPage.locator('[data-reader-body]').evaluate(el => getComputedStyle(el).transitionProperty)).toBe('none')

  // 翻页跨越第一章末页进入第二章时不应触发反向从左向右的动画
  const nextBtn = readerPage.getByRole('button', { name: '下一页' })
  while (!(await pageIndicator.textContent())?.includes('2/2 章')) {
    await nextBtn.click()
  }
  await expect(pageIndicator).toContainText('第 1 /')
  expect(await readerPage.locator('[data-reader-body]').evaluate(el => getComputedStyle(el).transitionProperty)).toBe('none')

  // 多级目录默认全部折叠：子章节「2.2 深入后半」初始隐藏；手动展开后可跳转且仅该子目录项激活
  const toc = readerPage.getByRole('navigation', { name: '章节目录' })
  await expect(toc.getByRole('button', { name: '2.2 深入后半' })).toBeHidden()
  await toc.getByRole('button', { name: '展开 第二章 深入' }).click()
  await expect(toc.getByRole('button', { name: '2.2 深入后半' })).toBeVisible()
  await toc.getByRole('button', { name: '2.2 深入后半' }).click()
  await expect(toc.locator('[aria-current="location"]')).toHaveCount(1)
  await expect(toc.locator('[aria-current="location"]')).toHaveText('2.2 深入后半')

  // 翻页到全书末尾，进度变为 100% 并同步回卡片
  while (!(await readerPage.getByRole('button', { name: '下一页' }).isDisabled())) {
    await readerPage.getByRole('button', { name: '下一页' }).click()
  }
  await expect(readerPage.getByLabel('阅读进度')).toContainText('100%')
  await expect(card).toContainText('100%', { timeout: 5000 })

  // 侧栏可收起，重开阅读页保持排版设置、分栏、动画开关、目录折叠状态与章节进度
  await readerPage.getByRole('button', { name: '收起侧栏' }).click()
  await expect(sidebar).toBeHidden()
  await readerPage.close()

  const [reopened] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('link', { name: '风之名' }).click(),
  ])
  await reopened.waitForLoadState('domcontentloaded')
  await expect(reopened.locator('[data-reader-body]')).toContainText('第二章 深入')
  await expect(reopened.locator('[data-reader-body]')).toHaveCSS('font-size', '22px')
  await expect(reopened.locator('[data-reader-body]')).toHaveCSS('font-weight', '600')
  await expect(reopened.getByRole('button', { name: '双栏' })).toHaveAttribute('aria-pressed', 'true')
  await expect(reopened.getByRole('switch', { name: '翻页动画' })).not.toBeChecked()
  await expect(reopened.getByRole('navigation', { name: '章节目录' }).getByRole('button', { name: '2.2 深入后半' })).toBeVisible()
})

test('夸克网盘 EPUB 分片上传、清空本机缓存后跨设备按需下载与删卡同步删除网盘文件', async () => {
  quark.partSize = 512 // 强制触发多分片上传
  const { context, page } = await openExtensionClient()

  // 连接夸克网盘
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '夸克网盘', exact: true }).click()
  await page.getByRole('button', { name: '扫码登录夸克' }).click()
  await expect(page.getByText(/当前夸克账号：/)).toBeVisible()

  await page.getByRole('button', { name: '我的空间', exact: true }).click()
  const epub = makeTestEpub({ title: '云端之书' })
  await dropEpubOnCollection(page, '日常收藏', 'cloud-book.epub', epub)

  const modal = page.getByRole('dialog', { name: '选择电子书保存与阅读方式' })
  await expect(modal).toBeVisible()
  await modal.getByRole('radio', { name: /上传到夸克网盘/ }).click()
  await modal.getByRole('button', { name: '确认添加' }).click()

  const card = page.locator('article[aria-label="电子书 云端之书"]')
  await expect(card).toBeVisible()

  // 等待分片上传至夸克「页墟收藏/电子书/」
  await expect.poll(() => [...quark.files.values()].some(f => !f.directory && f.name.endsWith('.epub')), { timeout: 10_000 }).toBe(true)
  const uploadedEntry = [...quark.files.values()].find(f => !f.directory && f.name.endsWith('.epub'))!
  expect(quark.files.get(uploadedEntry.parent)?.name).toBe('电子书')
  const uploadTask = [...quark.uploads.values()].find(u => u.fid === uploadedEntry.fid)!
  expect(uploadTask.parts.size).toBeGreaterThan(1)

  // 清空本机 IndexedDB 模拟第二台设备首次打开
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('page-garden-epubs', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    await new Promise<void>(resolve => {
      const tx = db.transaction('books', 'readwrite')
      tx.objectStore('books').clear()
      tx.oncomplete = () => { db.close(); resolve() }
    })
  })

  const [readerPage] = await Promise.all([
    context.waitForEvent('page'),
    card.getByRole('link', { name: '云端之书' }).click(),
  ])
  await expect(readerPage.locator('[data-reader-body]')).toContainText('第一章 初见', { timeout: 10_000 })
  await readerPage.close()

  // 验证同页内只存在唯一的「电子书」目录且批量/分片上传稳定
  const booksDirs = [...quark.files.values()].filter(f => f.directory && f.name === '电子书')
  expect(booksDirs).toHaveLength(1)

  // 单本删除后应同步清理夸克网盘中的 EPUB 文件
  await page.getByRole('button', { name: '更多操作 云端之书' }).click()
  await page.getByRole('menuitem', { name: '删除电子书' }).click()
  await expect(card).toBeHidden()
  await expect.poll(() => [...quark.files.values()].some(f => f.fid === uploadedEntry.fid), { timeout: 10_000 }).toBe(false)
})
