import { z } from 'zod'
import { active, equal, readDocument, type Document } from '../model'
import { listAll } from './auth'
import type { QuarkClient } from './client'
import type { QuarkEntry } from './types'

const temporaryPrefix = '.页墟上传-'
const previousPrefix = '.页墟旧版-'
const notePattern = /--([a-f0-9]{32})\.md$/
const receiptSchema = z.record(z.string(), z.object({ fid: z.string(), name: z.string(), size: z.number(), updatedAt: z.string().optional(), hash: z.string() }))
export type NoteReceipts = z.infer<typeof receiptSchema>
export function readNoteReceipts(value: unknown): NoteReceipts {
  const parsed = z.object({ noteReceipts: receiptSchema }).safeParse(value)
  return parsed.success ? parsed.data.noteReceipts : {}
}
async function digest(text: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...bytes].slice(0, 16).map(n => n.toString(16).padStart(2, '0')).join('')
}
async function noteName(title: string, id: string) {
  const suffix = await digest(id)
  const clean = (title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '新笔记').replace(/\.(md|markdown)$/i, '')
  return [...clean].slice(0, 80).join('') + '--' + suffix + '.md'
}

export async function recoverIndex(client: QuarkClient, root: QuarkEntry[], knownFid?: string) {
  const target = await digest('收藏.json')
  const old = root.filter(file => !file.isDirectory && file.name === previousPrefix + target + '-' + file.fid)
  const pending = root.filter(file => !file.isDirectory && file.name.startsWith(temporaryPrefix + target + '-') && /^[a-f0-9]{32}$/.test(file.name.slice((temporaryPrefix + target + '-').length)))
  const candidates = old.length ? old : pending
  if (!candidates.length) return undefined
  const selected = candidates.find(file => file.fid === knownFid) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!selected) throw new Error('夸克存在多个未完成的收藏文件，请检查备份；本地数据已保留')
  const body = await client.downloadFileText(selected.fid)
  if (new TextEncoder().encode(body).byteLength > 10_000_000) throw new Error('夸克收藏文件过大，请先导出并整理')
  let value: unknown
  try { value = JSON.parse(body) } catch { throw new Error('夸克临时收藏文件已损坏，本地数据已保留') }
  readDocument(value)
  if (!old.length && selected.name !== temporaryPrefix + target + '-' + await digest(body)) throw new Error('夸克临时收藏文件校验失败，本地数据已保留')
  await client.renameFile(selected.fid, '收藏.json')
  return { fid: selected.fid, body }
}

async function replace(client: QuarkClient, folder: string, entries: QuarkEntry[], name: string, body: string, mimeType: string, options: { readback: boolean; target?: string; knownBody?: string; beforeCommit?: () => Promise<void> }) {
  const target = options.target ?? await digest(name), temporaryName = temporaryPrefix + target + '-' + await digest(body)
  const previous = entries.filter(file => !file.isDirectory && file.name === name)
  const stale = entries.filter(file => !file.isDirectory && (file.name.startsWith(temporaryPrefix + target + '-') || file.name.startsWith(previousPrefix + target + '-')))
  if (options.readback && previous.length === 1 && (options.knownBody ?? await client.downloadFileText(previous[0].fid)) === body) {
    for (const file of stale) await client.deleteFile(file.fid)
    return previous[0]
  }
  const bytes = new TextEncoder().encode(body)
  if (bytes.byteLength > 10_000_000) throw new Error('夸克文件超过单次上传限制，本地内容已保留')
  // Markdown is a derived copy. Never trust an interrupted upload just by
  // its filename: start a fresh completed upload without reading its body.
  if (!options.readback) for (const file of stale.filter(file => file.name === temporaryName)) await client.deleteFile(file.fid)
  let uploaded: { fid: string } | undefined = options.readback ? entries.find(file => !file.isDirectory && file.name === temporaryName) : undefined
  uploaded ??= await client.uploadSmallFile({ parentFid: folder, fileName: temporaryName, bytes, mimeType })
  if (options.readback && await client.downloadFileText(uploaded.fid) !== body) throw new Error('夸克文件内容校验失败，旧文件已保留')
  await options.beforeCommit?.()
  const renamed: QuarkEntry[] = []
  try {
    for (const file of previous) { await client.renameFile(file.fid, previousPrefix + target + '-' + file.fid); renamed.push(file) }
    await client.renameFile(uploaded.fid, name)
  } catch (cause) {
    for (const file of renamed) await client.renameFile(file.fid, name).catch(() => undefined)
    throw cause
  }
  for (const file of [...previous, ...stale]) if (file.fid !== uploaded.fid && (options.readback || file.name !== temporaryName)) await client.deleteFile(file.fid)
  return { fid: uploaded.fid, parentFid: folder, name, isDirectory: false, size: bytes.byteLength }
}

export async function publishFiles(client: QuarkClient, folder: string, doc: Document, root: QuarkEntry[], currentBody: string | undefined, previousReceipts: NoteReceipts, syncVersion: number, beforeCommit: () => Promise<void>, noteIds: string[], prechecked: boolean) {
  let checked = prechecked
  async function check() { if (!checked) { await beforeCommit(); checked = true } }
  const notes = new Map(active(doc).filter(entity => entity.kind === 'note').map(note => [note.id, note]))
  const pending = [...new Set(noteIds)]
  let notesFolder = root.find(file => file.isDirectory && file.name === '笔记')?.fid
  if (!notesFolder && pending.some(id => notes.has(id))) { await check(); notesFolder = await client.createDirectory(folder, '笔记') }
  const receipts: NoteReceipts = Object.fromEntries(Object.entries(previousReceipts).filter(([id]) => notes.has(id)))
  if (notesFolder && pending.length) {
    const entries = await listAll(client, notesFolder)
    for (const id of pending) {
      const note = notes.get(id), suffix = await digest(id)
      const name = note ? await noteName(note.title, id) : undefined
      const obsolete = entries.filter(file => !file.isDirectory && notePattern.exec(file.name)?.[1] === suffix && file.name !== name)
      // Stable IDs also identify unfinished first uploads after a title
      // change or deletion, before any receipt has reached the JSON.
      const targets = new Set<string>([suffix])
      for (const oldName of [...obsolete.map(file => file.name), previousReceipts[id]?.name, name]) if (oldName) targets.add(await digest(oldName))
      let replaced = false
      if (note && name) {
        const hash = await digest(note.body), previous = previousReceipts[id]
        const matches = entries.filter(file => !file.isDirectory && file.name === name), file = matches[0]
        if (matches.length !== 1 || previous?.hash !== hash || previous.fid !== file.fid || previous.name !== name || previous.size !== file.size || previous.updatedAt !== file.updatedAt) {
          await check()
          const published = await replace(client, notesFolder, entries, name, note.body, 'text/markdown;charset=utf-8', { readback: false, target: suffix })
          receipts[id] = { fid: published.fid, name, size: published.size, hash }
          replaced = true
        }
      }
      for (const file of entries) {
        const artifact = /^(?:\.页墟上传-|\.页墟旧版-)([a-f0-9]{32})-/.exec(file.name)
        // replace already cleans artifacts for the current title. Limit all
        // other cleanup to this note, leaving unrelated Markdown untouched.
        if (obsolete.includes(file) || (!file.isDirectory && artifact && targets.has(artifact[1]) && (!replaced || artifact[1] !== suffix))) { await check(); await client.deleteFile(file.fid) }
      }
    }
  }
  const paths = Object.fromEntries(Object.entries(receipts).map(([id, receipt]) => [id, '笔记/' + receipt.name]))
  const content = { ...doc, noteFiles: paths, noteReceipts: receipts, syncVersion }
  const unchanged = currentBody !== undefined && equal(JSON.parse(currentBody), content)
  let body = unchanged ? currentBody : JSON.stringify(content, null, 2)
  if (!unchanged) {
    if (syncVersion >= Number.MAX_SAFE_INTEGER) throw new Error('夸克同步版本号超出范围，请导出备份后重新连接')
    content.syncVersion++
    body = JSON.stringify(content, null, 2)
  }
  const file = await replace(client, folder, root, '收藏.json', body, 'application/json', { readback: true, knownBody: currentBody, beforeCommit })
  return { file, body, receipts, syncVersion: content.syncVersion }
}
