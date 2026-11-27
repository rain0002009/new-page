import { listAll } from './auth'
import type { QuarkClient } from './client'

const booksFolderName = '电子书'

async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].slice(0, 16).map(n => n.toString(16).padStart(2, '0')).join('')
}

export async function epubQuarkFileName(title: string, id: string): Promise<string> {
  const suffix = await digest(id)
  const clean = (title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '未命名电子书').replace(/\.epub$/i, '')
  return [...clean].slice(0, 80).join('') + '--' + suffix + '.epub'
}

export async function ensureBooksFolder(client: QuarkClient, rootFolderId: string): Promise<string> {
  const rootEntries = await listAll(client, rootFolderId)
  const existing = rootEntries.find(entry => entry.isDirectory && entry.name === booksFolderName)
  if (existing) return existing.fid
  const created = await client.createDirectory(rootFolderId, booksFolderName)
  if (!created) throw new Error('无法在夸克网盘创建电子书目录')
  return created
}

export async function uploadBookToQuark(
  client: QuarkClient,
  rootFolderId: string,
  book: { id: string; title: string },
  bytes: Uint8Array,
): Promise<{ fid: string; fileName: string }> {
  const booksFolderFid = await ensureBooksFolder(client, rootFolderId)
  const fileName = await epubQuarkFileName(book.title, book.id)
  const suffix = await digest(book.id)
  const entries = await listAll(client, booksFolderFid)
  const stale = entries.filter(entry => !entry.isDirectory && entry.name.endsWith(`--${suffix}.epub`))
  const uploaded = await client.uploadFile({
    parentFid: booksFolderFid,
    fileName,
    bytes,
    mimeType: 'application/epub+zip',
  })
  for (const old of stale) {
    if (old.fid !== uploaded.fid) {
      await client.deleteFile(old.fid).catch(() => undefined)
    }
  }
  return { fid: uploaded.fid, fileName }
}
