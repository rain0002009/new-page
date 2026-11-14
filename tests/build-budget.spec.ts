import { test, expect } from '@playwright/test'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const output = resolve('dist/chrome')
const assetBudget = 1024 * 1024

async function assets(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? assets(path) : Promise.resolve(/\.(js|css)$/.test(entry.name) ? [path] : [])
  }))
  return nested.flat()
}

test('生产包的每个 JS 与 CSS 资源均在 1 MiB 预算内', async () => {
  const files = await assets(output)
  expect(files.length, '先运行 pnpm build:chrome 生成生产包').toBeGreaterThan(0)
  for (const file of files) {
    expect.soft((await stat(file)).size, relative(output, file)).toBeLessThanOrEqual(assetBudget)
  }
})
