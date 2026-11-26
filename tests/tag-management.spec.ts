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
        'tag-unused': { id: 'tag-unused', kind: 'tag', title: '闲置', parentId: null, position: 3, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false, color: 'green' },
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
  await expect(picker.getByRole('option', { name: /个人/ })).toHaveAttribute('data-active', 'false')
  await expect(picker.getByRole('button', { name: '编辑标签 个人' })).toBeHidden()
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

  await filter.getByRole('radio', { name: '任意颜色' }).click()
  await filter.getByRole('option', { name: /个人/ }).click()
  await expect(page.getByRole('article', { name: '笔记 示例笔记' })).toBeVisible()
  await expect(page.getByRole('article', { name: '链接 示例链接' })).toBeHidden()
})



test('标签面板阻止卡片拖拽并覆盖其它卡片', async () => {
  const { page } = await openSeededClient()
  const picker = await openTagPicker(page)
  const source = page.getByRole('article', { name: '链接 示例链接' })
  const target = page.getByRole('article', { name: '笔记 示例笔记' })
  const pickerBox = await picker.boundingBox()
  const targetBox = await target.boundingBox()
  expect(pickerBox).not.toBeNull()
  expect(targetBox).not.toBeNull()

  const targetActionBox = await page.getByRole('button', { name: '更多操作 示例笔记' }).boundingBox()
  expect(targetActionBox).not.toBeNull()
  const hit = await page.evaluate(([x, y]) => {
    const element = document.elementFromPoint(x, y)
    return { dialog: element?.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null, tag: element?.tagName, cls: element?.className, label: element?.getAttribute('aria-label') }
  }, [targetActionBox!.x + targetActionBox!.width / 2, targetActionBox!.y + targetActionBox!.height / 2])
  expect(hit.dialog).toBe('标签管理')
  expect(await picker.evaluate(element => getComputedStyle(element).backgroundColor)).not.toContain('rgba')
  const menuBox = await page.getByRole('menuitem', { name: '标签' }).boundingBox()
  expect(menuBox).not.toBeNull()
  await page.mouse.move(menuBox!.x + menuBox!.width / 2, menuBox!.y + menuBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 })
  await expect(source).not.toHaveAttribute('data-dragging', 'true')
  await page.mouse.up()

  await page.mouse.move(pickerBox!.x + pickerBox!.width / 2, pickerBox!.y + pickerBox!.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 8 })
  await expect(source).not.toHaveAttribute('data-dragging', 'true')
  await page.mouse.up()
})

test('标签面板在窄窗口边缘保持可见', async () => {
  const { page } = await openSeededClient()
  await page.setViewportSize({ width: 885, height: 445 })
  await page.getByRole('button', { name: '更多操作 工作收藏' }).click()
  await page.getByRole('menuitem', { name: '标签' }).hover()
  const picker = page.getByRole('dialog', { name: '标签管理' })
  const pickerBox = await picker.boundingBox()
  expect(pickerBox).not.toBeNull()
  expect(pickerBox!.x).toBeGreaterThanOrEqual(0)
  expect(pickerBox!.x + pickerBox!.width).toBeLessThanOrEqual(885)
  expect(pickerBox!.y).toBeGreaterThanOrEqual(0)
  expect(pickerBox!.y + pickerBox!.height).toBeLessThanOrEqual(445)

  const hit = await page.evaluate(([x, y]) => {
    const element = document.elementFromPoint(x, y)
    return element?.closest('[role="dialog"]')?.getAttribute('aria-label') ?? null
  }, [pickerBox!.x + pickerBox!.width / 2, pickerBox!.y + pickerBox!.height / 2])
  expect(hit).toBe('标签管理')
})

test('设置页标签管理反向查看与解绑', async () => {
  const { page } = await openSeededClient()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '标签管理' }).click()

  await expect(page.getByRole('heading', { name: '标签管理' })).toBeVisible()
  await expect(page.getByRole('button', { name: '返回设置' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开标签 工作' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开标签 工作' })).toContainText('2')

  await page.getByRole('button', { name: '展开标签 工作' }).click()
  await expect(page.getByRole('button', { name: '解绑 示例链接' })).toBeVisible()
  await expect(page.getByText('我的空间 / 工作收藏 / 示例链接')).toBeVisible()

  await page.getByRole('button', { name: '解绑 示例链接' }).click()
  await expect(page.getByRole('button', { name: '解绑 示例链接' })).toBeHidden()
  await expect(page.getByRole('button', { name: '收起标签 工作' })).toContainText('1')
})

test('标签管理定位具体卡片', async () => {
  const { page } = await openSeededClient()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '标签管理' }).click()
  await page.getByRole('button', { name: '展开标签 个人' }).click()
  await page.getByRole('button', { name: '定位 示例笔记' }).click()

  const target = page.getByRole('article', { name: '笔记 示例笔记' })
  await expect(target).toHaveAttribute('data-located', 'true')
  await expect(target).toBeVisible()
  const targetBox = await target.boundingBox()
  const viewport = page.viewportSize()
  expect(targetBox).not.toBeNull()
  expect(targetBox!.y).toBeGreaterThanOrEqual(0)
  expect(targetBox!.y + targetBox!.height).toBeLessThanOrEqual(viewport!.height)
})

test('标签管理搜索颜色与闲置标签', async () => {
  const { page } = await openSeededClient()
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '标签管理' }).click()

  await expect(page.getByRole('button', { name: '展开标签 闲置' })).toContainText('0 处使用')
  await page.getByLabel('搜索标签名称').fill('个人')
  await expect(page.getByRole('button', { name: '展开标签 工作' })).toBeHidden()
  await expect(page.getByRole('button', { name: '展开标签 个人' })).toBeVisible()

  await page.getByLabel('搜索标签名称').fill('')
  await page.getByRole('radio', { name: '粉色' }).click()
  await expect(page.getByRole('button', { name: '展开标签 个人' })).toBeVisible()
  await expect(page.getByRole('button', { name: '展开标签 工作' })).toBeHidden()

  await page.getByRole('radio', { name: '任意颜色' }).click()
  await page.getByRole('button', { name: '编辑标签 闲置' }).click()
  const editor = page.getByRole('dialog', { name: '编辑标签' })
  await editor.getByRole('textbox', { name: '名称' }).fill('已编辑')
  await editor.getByRole('radio', { name: '绿色' }).click()
  await editor.getByRole('button', { name: '保存' }).click()
  await expect(page.getByRole('button', { name: '展开标签 已编辑' })).toBeVisible()

  await page.getByRole('button', { name: '编辑标签 已编辑' }).click()
  await page.getByRole('dialog', { name: '编辑标签' }).getByRole('button', { name: '删除标签' }).click()
  await page.getByRole('dialog', { name: '永久删除标签' }).getByRole('button', { name: '永久删除' }).click()
  await expect(page.getByRole('button', { name: '展开标签 已编辑' })).toBeHidden()
})
