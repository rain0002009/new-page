import { test, expect, chromium, type Browser, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'

let browser: Browser
let source: string
let page: Page

test.beforeAll(async () => {
  source = stripTypeScriptTypes(await readFile('src/document/local-files.ts', 'utf8'))
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true })
})
test.beforeEach(async () => {
  page = await browser.newPage()
  await page.route('http://localhost/**', route => route.fulfill({ contentType: 'text/html', body: '<title>本地文件记录测试</title>' }))
  await page.goto('http://localhost/local-image-files')
})
test.afterEach(async () => { await page.context().close() })
test.afterAll(async () => { await browser?.close() })

test('重新打开同一个真实文件句柄复用稳定ID，保留草稿和原图片账号', async () => {
  const result = await page.evaluate(async code => {
    const { rememberFile, recallFile } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
    const directory = await navigator.storage.getDirectory()
    const handle = await directory.getFileHandle('note.md', { create: true })
    const draft = { title: 'note.md', body: '尚未保存正文', baseline: '磁盘正文', dirty: true, handle, imageSourceId: 'source-a' }
    const first = await rememberFile(draft, 'first-open')
    const reopened = { title: 'note.md', body: '磁盘正文', baseline: '磁盘正文', handle: await directory.getFileHandle('note.md'), imageSourceId: 'source-b' }
    const second = await rememberFile(reopened, 'second-open')
    const saved = await recallFile(second)
    return { first, second, body: saved.body, dirty: saved.dirty, source: saved.imageSourceId }
  }, source)
  expect(result).toEqual({ first: 'first-open', second: 'first-open', body: '尚未保存正文', dirty: true, source: 'source-a' })
})

test('并发记录同句柄使用一个ID，同名不同文件保持独立', async () => {
  const result = await page.evaluate(async code => {
    const { rememberFile } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
    const root = await navigator.storage.getDirectory()
    const left = await root.getDirectoryHandle('left', { create: true })
    const right = await root.getDirectoryHandle('right', { create: true })
    const file = (handle: FileSystemFileHandle) => ({ title: 'note.md', body: '', baseline: '', handle })
    const leftHandle = await left.getFileHandle('note.md', { create: true })
    const same = await Promise.all([rememberFile(file(leftHandle), 'first'), rememberFile(file(leftHandle), 'second')])
    const different = await rememberFile(file(await right.getFileHandle('note.md', { create: true })), 'different')
    return { same, different }
  }, source)
  expect(result.same).toEqual(['first', 'first'])
  expect(result.different).toBe('different')
})

test('清理通知失败后可重开恢复outbox，确认只移除对应项而保留后续项', async () => {
  const result = await page.evaluate(async code => {
    const { rememberFile, recallFile } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('outbox.md', { create: true })
    const first = { before: '![图](https://images.test/a.png)', after: '正文', sourceId: 'source-a' }
    const second = { before: '正文', after: '新正文', sourceId: 'source-a' }
    const file = { title: 'outbox.md', body: '正文', baseline: '正文', handle, pendingImageCleanup: [first] }
    const id = await rememberFile(file, 'outbox')
    const reopened = await recallFile(id)
    reopened.pendingImageCleanup.push(second)
    await rememberFile(reopened, id)
    const restored = await recallFile(id)
    await rememberFile(restored, id, [first])
    return { restored: reopened.pendingImageCleanup.length, remaining: (await recallFile(id)).pendingImageCleanup }
  }, source)
  expect(result.restored).toBe(2)
  expect(result.remaining).toEqual([{ before: '正文', after: '新正文', sourceId: 'source-a' }])
})

test('旧重复ID仅在句柄相同后成为别名，旧链接仍读取最新内容', async () => {
  const result = await page.evaluate(async code => {
    const { rememberFile, recallFile } = await import(`data:text/javascript,${encodeURIComponent(code)}`)
    const handle = await (await navigator.storage.getDirectory()).getFileHandle('alias.md', { create: true })
    const file = { title: 'alias.md', body: '旧正文', baseline: '旧正文', handle }
    await rememberFile(file, 'a-original')
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('page-garden-documents', 1)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('files', 'readwrite')
        tx.objectStore('files').put(file, 'z-old-duplicate')
        tx.oncomplete = () => { db.close(); resolve() }; tx.onerror = () => reject(tx.error)
      }
      request.onerror = () => reject(request.error)
    })
    const latest = { ...file, body: '最新正文', baseline: '最新正文' }
    const id = await rememberFile(latest, 'z-old-duplicate')
    const saved = await recallFile(id)
    return { id, aliases: saved.imageAliasIds, oldLink: (await recallFile('z-old-duplicate')).body }
  }, source)
  expect(result).toEqual({ id: 'a-original', aliases: ['z-old-duplicate'], oldLink: '最新正文' })
})
