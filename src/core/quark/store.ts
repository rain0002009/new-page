import { z } from 'zod'
import { canonical, readDocument, type Document } from '../model'
import { RevisionChanged } from '../webdav'
import { accountClient, listAll, type QuarkConnection } from './auth'
import type { QuarkClient } from './client'
import type { QuarkEntry } from './types'
import { QuarkApiError } from './types'
import { publishFiles, readNoteReceipts, recoverIndex, type NoteReceipts } from './published-files'

const currentName = '收藏.json'
const syncVersionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
function known(value: string | null) {
  try {
    const parsed = z.object({ fid: z.string().optional(), syncVersion: syncVersionSchema.optional() }).safeParse(JSON.parse(value ?? 'null'))
    return parsed.success ? parsed.data : {}
  } catch { return {} }
}
function current(root: QuarkEntry[]) {
  const files = root.filter(file => !file.isDirectory && file.name === currentName)
  if (files.length > 1) throw new Error('夸克存在多个收藏.json，请保留备份并整理后重试')
  return files[0]
}
function revision(file: QuarkEntry | undefined, syncVersion: number) {
  return file ? canonical({ fid: file.fid, size: file.size, updatedAt: file.updatedAt ?? null, syncVersion }) : null
}
function history(file: QuarkEntry) {
  return (file.isDirectory && file.name === '同步历史') || (!file.isDirectory && /^pg[12]-[a-f0-9]{32}\.json$/.test(file.name))
}

// The local workspace retains the merge baseline. Quark holds only current
// files; its API offers no atomic compare-and-swap for simultaneous writers.
export class QuarkStore {
  private root: QuarkEntry[] = []
  private body: string | undefined
  private receipts: NoteReceipts = {}
  private etag: string | null = null
  private loaded = false
  private syncVersion = 0
  constructor(private config: QuarkConnection, private knownRevision: string | null = null, private noteIds: string[] = [], private repairing = false) {}
  async verify() { await (await accountClient(this.config)).getAccountInfo() }
  async read() {
    const client = await accountClient(this.config)
    this.root = await listAll(client, this.config.folderId)
    let file = current(this.root)
    const recovered = !file ? await recoverIndex(client, this.root, known(this.knownRevision).fid) : undefined
    if (recovered) { this.root = await listAll(client, this.config.folderId); file = current(this.root) }
    if (!file) {
      if (!this.repairing && (this.knownRevision || this.root.some(history))) throw new Error('夸克收藏.json 已被移除，请在设置中修复夸克同步；本地数据已保留')
      this.syncVersion = known(this.knownRevision).syncVersion ?? 0
      this.loaded = true
      return { doc: null, etag: null }
    }
    this.body = recovered?.fid === file.fid ? recovered.body : await client.downloadFileText(file.fid)
    if (new TextEncoder().encode(this.body).byteLength > 10_000_000) throw new Error('夸克收藏文件过大，请先导出并整理')
    let value: unknown
    try { value = JSON.parse(this.body) } catch { throw new Error('夸克收藏文件已损坏，原文件未被覆盖') }
    const doc = readDocument(value)
    const version = z.object({ syncVersion: syncVersionSchema.default(0) }).safeParse(value)
    if (!version.success) throw new Error('夸克同步版本号无效，本地数据已保留')
    this.syncVersion = version.data.syncVersion
    if (this.syncVersion < (known(this.knownRevision).syncVersion ?? 0)) throw new Error('夸克的新版本尚未出现在目录列表中，请稍后重试；本地修改已保留')
    this.etag = revision(file, this.syncVersion)
    this.receipts = readNoteReceipts(value)
    this.loaded = true
    return { doc, etag: this.etag }
  }
  private async check(client: QuarkClient, expected: string | null) {
    const root = await listAll(client, this.config.folderId)
    if (revision(current(root), this.syncVersion) !== expected) throw new RevisionChanged()
    return root
  }
  private async publish(doc: Document, expected: string | null, writing: boolean) {
    if (!this.loaded) await this.read()
    if (this.etag !== expected) throw new RevisionChanged()
    doc = readDocument(doc)
    const client = await accountClient(this.config)
    const root = writing ? await this.check(client, expected) : this.root
    let result: Awaited<ReturnType<typeof publishFiles>>
    try {
      const noteIds = this.repairing ? [...new Set([...this.noteIds, ...Object.values(doc.entities).filter(entity => entity.kind === 'note').map(entity => entity.id)])] : this.noteIds
      result = await publishFiles(client, this.config.folderId, doc, root, this.body, this.receipts, this.syncVersion, () => this.check(client, expected).then(() => undefined), noteIds, writing)
    } catch (cause) {
      if (cause instanceof QuarkApiError && (cause.status === 409 || cause.status === 404)) throw new RevisionChanged()
      throw cause
    }
    // Remove obsolete history only after a valid current document and its
    // pending Markdown operations have completed. Failed cleanup retries next sync.
    if (result.file.fid !== current(root)?.fid) {
      const published = current(await listAll(client, this.config.folderId))
      if (!published || published.fid !== result.file.fid) throw new RevisionChanged()
      result.file = published
    }
    for (const file of root.filter(history)) await client.deleteFile(file.fid)
    this.root = root.filter(file => !history(file) && file.name !== currentName).concat(result.file)
    this.body = result.body
    this.receipts = result.receipts
    this.syncVersion = result.syncVersion
    this.etag = revision(result.file, this.syncVersion)
    return this.etag!
  }
  write(doc: Document, previous: string | null) { return this.publish(doc, previous, true) }
  settle(doc: Document, expected: string) { return this.publish(doc, expected, false) }
}
