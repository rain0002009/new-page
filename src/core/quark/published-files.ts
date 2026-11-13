import { active, type Document } from '../model'
import { listAll } from './auth'
import type { QuarkClient } from './client'
import type { QuarkEntry } from './types'

const temporaryPrefix = '.拾页上传-'
const previousPrefix = '.拾页旧版-'
const notePattern = /--([a-f0-9]{32})\.md$/
async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].slice(0, 16).map(n => n.toString(16).padStart(2, '0')).join('')
}
async function noteName(title: string, id: string) {
  const suffix = await digest(id)
  const clean = (title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '新笔记').replace(/\.(md|markdown)$/i, '')
  return `${[...clean].slice(0, 80).join('')}--${suffix}.md`
}

async function replace(client: QuarkClient, folder: string, entries: QuarkEntry[], name: string, body: string, mimeType: string) {
  const target = await digest(name), temporaryName = `${temporaryPrefix}${target}-${await digest(body)}`
  const previous = entries.filter(file => !file.isDirectory && file.name === name)
  const stale = entries.filter(file => !file.isDirectory && (file.name.startsWith(`${temporaryPrefix}${target}-`) || file.name.startsWith(`${previousPrefix}${target}-`)))
  if (previous.length === 1 && await client.downloadFileText(previous[0].fid) === body) {
    for (const file of stale) await client.deleteFile(file.fid)
    return
  }
  const bytes = new TextEncoder().encode(body)
  if (bytes.byteLength > 10_000_000) throw new Error('夸克文件超过单次上传限制，本地内容已保留')
  let uploaded: { fid: string } | undefined = entries.find(file => !file.isDirectory && file.name === temporaryName)
  uploaded ??= await client.uploadSmallFile({ parentFid: folder, fileName: temporaryName, bytes, mimeType })
  if (await client.downloadFileText(uploaded.fid) !== body) throw new Error('夸克文件内容校验失败，旧文件已保留')
  const renamed: QuarkEntry[] = []
  try {
    // Preserve old bytes under temporary names while freeing the target name;
    // providers may reject renaming onto an existing filename.
    for (const file of previous) { await client.renameFile(file.fid, `${previousPrefix}${target}-${file.fid}`); renamed.push(file) }
    await client.renameFile(uploaded.fid, name)
  } catch (cause) {
    for (const file of renamed) await client.renameFile(file.fid, name).catch(() => undefined)
    throw cause
  }
  for (const file of [...previous, ...stale]) if (file.fid !== uploaded.fid) await client.deleteFile(file.fid)
}

export async function publishFiles(client: QuarkClient, folder: string, doc: Document) {
  const root = await listAll(client, folder)
  const notes = active(doc).filter(entity => entity.kind === 'note')
  let notesFolder = root.find(file => file.isDirectory && file.name === '笔记')?.fid
  if (!notesFolder && notes.length) notesFolder = await client.createDirectory(folder, '笔记')
  if (notes.length && !notesFolder) throw new Error('夸克笔记目录尚未可见，请稍后重试')
  const paths: Record<string, string> = {}
  if (notesFolder) {
    const entries = await listAll(client, notesFolder), names = new Set<string>()
    const targets = new Set<string>()
    for (const note of notes) {
      const name = await noteName(note.title, note.id)
      names.add(name); paths[note.id] = `笔记/${name}`
      targets.add(await digest(name))
      await replace(client, notesFolder, entries, name, note.body, 'text/markdown;charset=utf-8')
    }
    for (const file of entries) {
      const artifact = /^(?:\.拾页上传-|\.拾页旧版-)([a-f0-9]{32})-/.exec(file.name)
      if (!file.isDirectory && ((notePattern.test(file.name) && !names.has(file.name)) || (artifact && !targets.has(artifact[1])))) await client.deleteFile(file.fid)
    }
  }
  const index = JSON.stringify({ ...doc, noteFiles: paths }, null, 2)
  await replace(client, folder, root, '收藏.json', index, 'application/json')
}
