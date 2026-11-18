import { test, expect, chromium } from '@playwright/test'
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

test('长文档中的代码块直接完成渲染且离屏不销毁，滚动停止后页面内容不发生自发跳动', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'new-page-scroll-'))
  const extension = join(profile, 'extension')
  await cp(resolve('dist/chrome'), extension, { recursive: true })
  const manifestPath = join(extension, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.host_permissions = ['<all_urls>', 'file:///*']
  await writeFile(manifestPath, JSON.stringify(manifest))

  // 构造包含多个大型代码块的长文档
  const testDocPath = join(profile, 'long-document.md')
  let markdown = '# 滚动稳定性测试长文档\n\n'
  for (let i = 1; i <= 15; i++) {
    markdown += `## 章节 ${i}\n\n`
    markdown += '```typescript\n'
    for (let line = 1; line <= 25; line++) {
      markdown += `const line_${i}_${line} = "Testing CodeMirror eager rendering stability and layout shift prevention";\n`
    }
    markdown += '```\n\n'
  }
  markdown += '## 目标稳定定位标题\n\n目标章节正文。\n'
  await writeFile(testDocPath, markdown, 'utf8')

  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    ignoreHTTPSErrors: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    viewport: { width: 1200, height: 800 },
    args: ['--enable-unsafe-extension-debugging', '--ignore-certificate-errors', '--allow-file-access-from-files'],
  })

  try {
    const session = await context.browser()!.newBrowserCDPSession()
    const { id } = await session.send('Extensions.loadUnpacked', { path: extension })
    const page = await context.newPage()

    await page.addInitScript(() => {
      chrome.extension.isAllowedFileSchemeAccess = (() => Promise.resolve(true)) as typeof chrome.extension.isAllowedFileSchemeAccess
    })

    const fileUrl = pathToFileURL(testDocPath).href
    const targetUrl = `chrome-extension://${id}/document/index.html?url=${encodeURIComponent(fileUrl)}`
    await page.goto(targetUrl)
    await expect(page.getByRole('textbox', { name: 'Markdown 正文', exact: true })).toBeVisible({ timeout: 10000 })

    // 验证所有代码块均立即渲染为完整 CodeMirror 编辑器，无占位符残留
    const placeholderCount = await page.evaluate(() => document.querySelectorAll('.milkdown-code-block-placeholder').length)
    expect(placeholderCount).toBe(0)

    // 滚动到文档下半部分的目标标题处
    await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('h2')).find(h => h.textContent?.includes('章节 12'))
      target?.scrollIntoView({ behavior: 'instant', block: 'start' })
    })

    // 记录停止滚动瞬间的标题视口坐标
    const initialTop = await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('h2')).find(h => h.textContent?.includes('章节 12'))
      return target ? target.getBoundingClientRect().top : null
    })
    expect(initialTop).not.toBeNull()

    // 等待 1.5 秒，观察停止滚动后是否有异步组件挂载导致的布局推挤
    await page.waitForTimeout(1500)

    const finalTop = await page.evaluate(() => {
      const target = Array.from(document.querySelectorAll('h2')).find(h => h.textContent?.includes('章节 12'))
      return target ? target.getBoundingClientRect().top : null
    })
    const shift = (finalTop ?? 0) - (initialTop ?? 0)

    // 视口相对位置不发生任何位移
    expect(Math.abs(shift)).toBeLessThan(1)

    // 确保离屏代码块不会在超出原 5s 延迟后被销毁还原成占位符
    const placeholdersAfterScroll = await page.evaluate(() => document.querySelectorAll('.milkdown-code-block-placeholder').length)
    expect(placeholdersAfterScroll).toBe(0)
  } finally {
    await context.close()
    await rm(profile, { recursive: true, force: true })
  }
})
