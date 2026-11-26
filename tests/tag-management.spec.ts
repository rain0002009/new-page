import { test, expect, chromium, type BrowserContext } from '@playwright/test'
import { mkdtemp, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const clients: { context: BrowserContext; profile: string }[] = []

test.afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.context.close()
    await rm(client.profile, { recursive: true, force: true })
  }
})

async function openSeededClient() {
  const profile = await mkdtemp(join(tmpdir(), 'new-page-tag-e2e-'))
  const extension = join(profile, 'extension')
  await cp(resolve('dist/chrome'), extension, { recursive: true })
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1500, height: 960 },
    args: ['--enable-unsafe-extension-debugging'],
  })
  clients.push({ context, profile })
  const session = await context.browser()!.newBrowserCDPSession()
  const { id } = await session.send('Extensions.loadUnpacked', { path: extension })
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 10_000 })
  await worker.evaluate(async () => {
    const doc = {
      format: 'new-page',
      version: 1,
      entities: {
        profile: { id: 'profile', kind: 'profile', title: 'Rain', parentId: null, position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false },
        space: { id: 'space', kind: 'space', title: '我的空间', parentId: null, position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false },
        collection: { id: 'collection', kind: 'collection', title: '工作收藏', parentId: 'space', position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false, collapsed: false, tagIds: ['tag-work'] },
        link: { id: 'link', kind: 'link', title: '示例链接', parentId: 'collection', position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false, url: 'https://example.com', icon: '', note: '原备注', todo: false, tagIds: ['tag-work'] },
        note: { id: 'note', kind: 'note', title: '示例笔记', parentId: 'collection', position: 2, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false, body: '# 示例\n正文摘要', tagIds: ['tag-personal'] },
        'tag-work': { id: 'tag-work', kind: 'tag', title: '工作', parentId: null, position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false, color: 'blue' },
        'tag-personal': { id: 'tag-personal', kind: 'tag', title: '个人', parentId: null, position: 2, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false, color: 'pink' },
      },
    }
    const root = {
      active: 'local',
      sources: {
        local: { config: null, doc, base: doc, etag: null, conflicts: [], status: 'local', error: '', lastSync: null },
      },
    }
    await chrome.storage.local.set({ 'new-page.workspace.v1': root })
  })
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/chrome_url_overrides/newtab.html`)
  return { page }
}

async function openTagPicker(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '更多操作 示例链接' }).click()
  await page.getByRole('menuitem', { name: '标签' }).hover()
  return page.getByRole('dialog', { name: '标签管理' })
}

test('标签下拉保持打开并支持键盘选择', async () => {
  const { page } = await openSeededClient()
  const picker = await openTagPicker(page)
  const search = picker.getByLabel('搜索或创建标签')

  await search.pressSequentially('连续输入')
  await expect(picker).toBeVisible()
  await expect(picker.getByRole('button', { name: /创建/ })).toBeHidden()

  await search.fill('')
  await search.pressSequentially('个人')
  await search.press('ArrowDown')
  await expect(picker.getByRole('option', { name: /个人/ })).toHaveAttribute('data-active', 'true')
  await search.press('Enter')
  await expect(picker.getByRole('option', { name: /个人/ })).toHaveAttribute('aria-selected', 'true')
  await expect(picker).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()
})

test('搜索框回车直接创建标签，透明使用第一个颜色', async () => {
  const { page } = await openSeededClient()
  const picker = await openTagPicker(page)
  const search = picker.getByLabel('搜索或创建标签')

  await search.fill('紧急')
  await search.press('Enter')
  await expect(picker.getByRole('option', { name: /紧急/ })).toHaveAttribute('aria-selected', 'true')

  await search.fill('透明标签')
  await search.press('Enter')
  await expect(picker.getByRole('option', { name: /透明标签/ })).toHaveAttribute('aria-selected', 'true')
  await expect(picker.getByRole('button', { name: /创建/ })).toBeHidden()
})

test('编辑弹窗可连续添加标签', async () => {
  const { page } = await openSeededClient()
  await page.getByRole('button', { name: '编辑链接' }).click()
  const editor = page.getByRole('dialog', { name: '编辑链接' })
  const search = editor.getByLabel('搜索或创建标签')

  await search.fill('紧急')
  await search.press('Enter')
  await expect(editor.getByRole('button', { name: '移除标签 紧急' })).toBeVisible()

  await search.fill('复查')
  await search.press('Enter')
  await expect(editor.getByRole('button', { name: '移除标签 紧急' })).toBeVisible()
  await expect(editor.getByRole('button', { name: '移除标签 复查' })).toBeVisible()
})

test('空间标签筛选支持搜索和颜色过滤', async () => {
  const { page } = await openSeededClient()
  await page.getByRole('button', { name: '筛选' }).click()
  const filter = page.getByRole('dialog', { name: '筛选收藏' })
  const search = filter.getByLabel('筛选标签')

  await search.fill('个人')
  await expect(filter.getByRole('option', { name: /个人/ })).toBeVisible()
  await expect(filter.getByRole('option', { name: /工作/ })).toBeHidden()

  await search.fill('')
  await filter.getByRole('radio', { name: '蓝色' }).click()
  await expect(filter.getByRole('option', { name: /工作/ })).toBeVisible()
  await expect(filter.getByRole('option', { name: /个人/ })).toBeHidden()

  await filter.getByRole('radio', { name: '透明' }).click()
  await filter.getByRole('option', { name: /个人/ }).click()
  await expect(page.getByRole('article', { name: '笔记 示例笔记' })).toBeVisible()
  await expect(page.getByRole('article', { name: '链接 示例链接' })).toBeHidden()
})

