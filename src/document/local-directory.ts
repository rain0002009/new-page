import { markdownName } from './local-files'

export const fileAccessMessage = '请在扩展详情中开启「允许访问文件网址」，然后重试'
export type LocalDirectoryEntry = { name: string; url: string; kind: 'file' | 'directory' }

export async function requireFileUrlAccess() {
  if (!await chrome.extension.isAllowedFileSchemeAccess()) throw new Error(fileAccessMessage)
}

export function fileDirectoryUrl(address: string) {
  if (!address) throw new Error('无法定位文件所在文件夹，请通过本地文件网址打开 Markdown')
  const url = new URL(address)
  if (url.protocol !== 'file:') throw new Error('无法定位文件所在文件夹，请通过本地文件网址打开 Markdown')
  return new URL('.', url).href
}

export async function readLocalDirectory(address: string, signal?: AbortSignal): Promise<LocalDirectoryEntry[]> {
  await requireFileUrlAccess()
  const directory = new URL(address)
  if (directory.protocol !== 'file:' || !directory.pathname.endsWith('/')) throw new Error('无效的本地文件夹地址')
  let response: Response
  try {
    response = await fetch(directory.href, { signal: signal ?? AbortSignal.timeout(30_000) })
  } catch {
    await requireFileUrlAccess()
    throw new Error('无法读取文件夹，请检查文件夹是否存在后重试')
  }
  // Chrome's generated file-directory listing has status 0 despite containing HTML.
  if (!response.ok && response.status !== 0) throw new Error('无法读取文件夹，请检查文件夹是否存在后重试')
  const html = await response.text()
  const document = new DOMParser().parseFromString(html, 'text/html')
  if (!document.querySelector('#tbody')) throw new Error('无法识别本地目录，请重试')
  const entries: LocalDirectoryEntry[] = []
  for (const script of document.querySelectorAll('script')) {
    const match = /^\s*addRow\(([\s\S]*)\);?\s*$/.exec(script.textContent ?? '')
    if (!match) continue
    // Parse only JSON arguments. Never execute scripts from directory listings.
    const row: unknown = JSON.parse(`[${match[1]}]`)
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || ![0, 1].includes(row[2])) continue
    const [name, path, flag] = row
    if (flag === 0 && !markdownName(name)) continue
    const url = new URL(path, directory)
    const relative = url.pathname.slice(directory.pathname.length).replace(/\/$/, '')
    if (url.protocol !== 'file:' || url.host !== directory.host || !url.pathname.startsWith(directory.pathname) || !relative || relative.includes('/') || url.search || url.hash) continue
    if (flag === 1 && !url.pathname.endsWith('/')) url.pathname += '/'
    entries.push({ name, url: url.href, kind: flag === 1 ? 'directory' : 'file' })
  }
  return entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
}
