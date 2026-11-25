import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
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
  return { page, id }
}

test('标签显示、工具菜单与编辑', async () => {
  const { page } = await openSeededClient()
  await expect(page.getByRole('article', { name: '链接 示例链接' })).toBeVisible()
  await expect(page.getByRole('article', { name: '链接 示例链接' }).getByText('工作')).toBeVisible()
  await expect(page.getByRole('article', { name: '笔记 示例笔记' }).getByText('个人')).toBeVisible()

  await page.getByRole('button', { name: '更多操作 示例链接' }).click()
  await expect(page.getByRole('menuitem', { name: '标签' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: '删除链接' })).toBeVisible()
  await page.getByRole('menuitem', { name: '标签' }).hover()
  const quickPicker = page.getByRole('dialog', { name: '标签管理' })
  await expect(quickPicker).toBeVisible()
  await quickPicker.getByRole('button', { name: '个人', exact: true }).click()
  await expect(quickPicker.getByRole('button', { name: '个人', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(quickPicker).toBeVisible()

  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '编辑链接' }).click()
  const editor = page.getByRole('dialog', { name: '编辑链接' })
  await editor.getByLabel('搜索或创建标签').fill('紧急')
  await expect(editor.getByRole('button', { name: '创建「紧急」' })).toBeHidden()
  await editor.getByRole('radio', { name: '红色' }).click()
  await editor.getByRole('button', { name: '创建「紧急」' }).click()
  await expect(editor.getByRole('button', { name: '移除标签 紧急' })).toBeVisible()

  await editor.getByLabel('搜索或创建标签').fill('复查')
  await editor.getByRole('radio', { name: '蓝色' }).click()
  await editor.getByRole('button', { name: '创建「复查」' }).click()
  await expect(editor.getByRole('button', { name: '移除标签 紧急' })).toBeVisible()
  await expect(editor.getByRole('button', { name: '移除标签 复查' })).toBeVisible()
})

test('空间标签筛选', async () => {
  const { page } = await openSeededClient()
  await page.getByRole('button', { name: '标签筛选' }).click()
  await page.getByRole('dialog', { name: '标签筛选' }).getByRole('button', { name: '个人', exact: true }).click()
  await expect(page.getByRole('article', { name: '笔记 示例笔记' })).toBeVisible()
  await expect(page.getByRole('article', { name: '链接 示例链接' })).toBeHidden()
  await page.getByRole('dialog', { name: '标签筛选' }).getByRole('button', { name: '工作', exact: true }).click()
  await expect(page.getByRole('article', { name: '链接 示例链接' })).toBeVisible()
  await expect(page.getByRole('article', { name: '笔记 示例笔记' })).toBeVisible()
})


