import { z } from 'zod'
import { canonical, readDocument, type Document, type Conflict } from '../model'
import { emptyDocument, merge } from '../merge'
import { RevisionChanged } from '../webdav'
import { accountClient, listAll, type QuarkConnection } from './auth'
import type { QuarkClient } from './client'
import type { QuarkEntry } from './types'
import { QuarkApiError } from './types'
import { publishFiles } from './published-files'

const clockSchema = z.record(z.string().uuid(), z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
type Clock = z.infer<typeof clockSchema>
type Revision = { id: string; clock: Clock }
type Snapshot = Revision & { format: 'page-garden-snapshot'; version: 2; base: { clock: Clock; document: Document }; document: Document }
type Stored = { snapshot: Snapshot; files: QuarkEntry[] }
const historyName = '同步历史'
const filePattern = /^pg2-([a-f0-9]{32})\.json$/
const retainedHistory = 10
const dominates = (a: Clock, b: Clock) => Object.entries(b).every(([writer, count]) => (a[writer] ?? 0) >= count)
const weight = (clock: Clock) => Object.values(clock).reduce((sum, count) => sum + count, 0)
function combined(clocks: Clock[]): Clock {
  const result: Clock = {}
  for (const clock of clocks) for (const [writer, count] of Object.entries(clock)) result[writer] = Math.max(result[writer] ?? 0, count)
  return result
}
function revision(heads: Stored[]) { return JSON.stringify(heads.map(({ snapshot: { id, clock } }) => ({ id, clock })).sort((a, b) => a.id.localeCompare(b.id))) }
function revisions(value: string | null): Revision[] {
  if (!value) return []
  const parsed: unknown = JSON.parse(value)
  const result = z.array(z.object({ id: z.string().regex(/^[a-f0-9]{32}$/), clock: clockSchema })).max(6).safeParse(parsed)
  if (!result.success) throw new Error('夸克同步状态格式不兼容，请清除扩展测试数据后重新连接')
  return result.data
}
let writerPromise: Promise<string> | undefined
function writerId() {
  return writerPromise ??= (async () => {
    const key = 'new-page.quark.writer.v2'
    const stored = await chrome.storage.local.get(key)
    if (typeof stored[key] === 'string' && z.string().uuid().safeParse(stored[key]).success) return stored[key] as string
    const id = crypto.randomUUID()
    await chrome.storage.local.set({ [key]: id })
    return id
  })().catch(error => { writerPromise = undefined; throw error })
}
async function contentId(value: Pick<Snapshot, 'clock' | 'base' | 'document'>) {
  const bytes = new TextEncoder().encode(canonical({ clock: value.clock, base: value.base, document: value.document }))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 16).map(n => n.toString(16).padStart(2, '0')).join('')
}
async function mergeWriter(parents: Revision[], document: Document) {
  const bytes = new TextEncoder().encode(canonical({ parents: [...parents].sort((a, b) => a.id.localeCompare(b.id)), document }))
  const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].slice(0, 16).map(n => n.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`
}
async function load(client: QuarkClient, file: QuarkEntry): Promise<Snapshot> {
  const text = await client.downloadFileText(file.fid)
  if (new TextEncoder().encode(text).byteLength > 10_000_000) throw new Error('夸克收藏文件过大，请先导出并整理')
  let value: Snapshot
  try { value = JSON.parse(text) } catch { throw new Error('夸克收藏文件已损坏，原文件未被覆盖') }
  if (value?.format !== 'page-garden-snapshot' || value.version !== 2 || file.name !== `pg2-${value.id}.json` ||
      !clockSchema.safeParse(value.clock).success || !clockSchema.safeParse(value.base?.clock).success ||
      !dominates(value.clock, value.base.clock) || weight(value.clock) !== weight(value.base.clock) + 1) throw new Error('夸克收藏版本格式不兼容，原文件未被覆盖')
  if (await contentId(value) !== value.id) throw new Error('夸克收藏内容校验失败，原文件未被覆盖')
  // Validate the original bytes before filling in newer optional fields.
  readDocument(value.document)
  readDocumentOrEmpty(value.base.document)
  return value
}
function readDocumentOrEmpty(doc: Document) {
  if (canonical(doc) === canonical(emptyDocument())) return emptyDocument()
  return readDocument(doc)
}

// Each commit contains a baseline. Vector clocks identify dominated versions so
// pruning never depends on keeping an unbounded chain of ancestor files.
export class QuarkStore {
  private base = emptyDocument()
  private snapshots = new Map<string, { metadata: string; snapshot: Snapshot }>()
  constructor(private config: QuarkConnection, private knownRevision: string | null = null) {}
  async verify() { await (await accountClient(this.config)).getAccountInfo() }
  private async snapshot(client: QuarkClient, file: QuarkEntry) {
    const metadata = canonical({ name: file.name, size: file.size, updatedAt: file.updatedAt ?? null })
    const cached = this.snapshots.get(file.fid)
    if (cached?.metadata === metadata) return cached.snapshot
    const snapshot = await load(client, file)
    // A store lives for one synchronization. Reuse verified immutable history
    // bytes during its repeated directory checks, while still listing new heads.
    this.snapshots.set(file.fid, { metadata, snapshot })
    return snapshot
  }
  private async metadata(client: QuarkClient) {
    const root = await listAll(client, this.config.folderId)
    const folders = root.filter(file => file.isDirectory && file.name === historyName).sort((a, b) => a.fid.localeCompare(b.fid))
    const nodes = new Map<string, Stored>()
    for (const folder of folders) for (const file of await listAll(client, folder.fid)) {
      const match = !file.isDirectory && file.name.match(filePattern)
      if (!match) {
        if (!file.isDirectory && /^pg\d+-/.test(file.name)) throw new Error('夸克收藏版本格式不兼容，请保留文件并检查备份')
        continue
      }
      const previous = nodes.get(match[1])
      if (previous) { previous.files.push(file); continue }
      nodes.set(match[1], { snapshot: await this.snapshot(client, file), files: [file] })
    }
    const values = [...nodes.values()]
    if (values.some((node, index) => values.slice(index + 1).some(other => canonical(node.snapshot.clock) === canonical(other.snapshot.clock)))) throw new Error('夸克设备版本标识冲突，请导出备份并重新连接')
    const heads = values.filter(node => !values.some(other => other !== node && dominates(other.snapshot.clock, node.snapshot.clock)))
      .sort((a, b) => a.snapshot.id.localeCompare(b.snapshot.id))
    if (heads.length > 6) throw new Error('并行版本较多，请先完成现有版本的合并')
    if (revisions(this.knownRevision).some(known => !heads.some(head => dominates(head.snapshot.clock, known.clock)))) throw new Error('夸克的新版本尚未出现在目录列表中，请稍后重试；本地修改已保留')
    return { root, folders, nodes, heads }
  }
  async read(): Promise<{ doc: Document | null; etag: string | null; conflicts: Conflict[] }> {
    const client = await accountClient(this.config)
    const { root, nodes, heads } = await this.metadata(client)
    if (!heads.length) {
      if (root.some(file => /^pg1-/.test(file.name))) throw new Error('检测到旧版测试文件，请清空旧测试数据后重新连接')
      if (root.some(file => file.name === '收藏.json') || revisions(this.knownRevision).length) throw new Error('夸克同步历史已被移除，请检查备份；本地数据已保留')
      return { doc: null, etag: null, conflicts: [] }
    }
    // Prefer the most recent baseline common to all heads. For branches older
    // than retained history, merging from empty retains differences as conflicts.
    const candidates = [...nodes.values()].flatMap(({ snapshot }) => [
      { clock: snapshot.clock, document: snapshot.document }, snapshot.base,
    ]).filter(candidate => heads.every(head => dominates(head.snapshot.clock, candidate.clock)))
      .sort((a, b) => weight(b.clock) - weight(a.clock) || canonical(a.clock).localeCompare(canonical(b.clock)))
    const base = candidates[0]?.document ?? emptyDocument()
    let doc = readDocument(heads[0].snapshot.document)
    const conflicts: Conflict[] = []
    for (const head of heads.slice(1)) {
      const result = merge(readDocumentOrEmpty(base), doc, readDocument(head.snapshot.document))
      doc = result.doc
      conflicts.push(...result.conflicts.map(conflict => ({ ...conflict, id: `${head.snapshot.id}:${conflict.id}` })))
    }
    this.base = readDocument(doc)
    return { doc: this.base, etag: revision(heads), conflicts }
  }
  async write(doc: Document, previous: string | null): Promise<string> {
    readDocument(doc)
    const parents = revisions(previous), baseClock = combined(parents.map(parent => parent.clock))
    // Devices consolidating the same branches and document produce one commit,
    // rather than repeatedly creating competing merge commits on every retry.
    const writer = parents.length > 1 ? await mergeWriter(parents, doc) : await writerId()
    const clock = { ...baseClock, [writer]: (baseClock[writer] ?? 0) + 1 }
    const value = { clock, base: { clock: baseClock, document: this.base }, document: doc }
    const snapshot: Snapshot = { format: 'page-garden-snapshot', version: 2, id: await contentId(value), ...value }
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot))
    if (bytes.byteLength > 10_000_000) throw new Error('收藏数据超过单次上传限制，请先导出备份并整理')
    const client = await accountClient(this.config)
    const meta = await this.metadata(client)
    if (!meta.nodes.has(snapshot.id)) {
      const folder = meta.folders[0]?.fid ?? await client.createDirectory(this.config.folderId, historyName)
      if (!folder) throw new Error('夸克同步历史目录尚未可见，请稍后重试')
      const uploaded = await client.uploadSmallFile({ parentFid: folder, fileName: `pg2-${snapshot.id}.json`, bytes, mimeType: 'application/json' })
      await load(client, { fid: uploaded.fid, name: `pg2-${snapshot.id}.json`, parentFid: folder, isDirectory: false, size: bytes.byteLength })
    }
    // A simultaneous commit is a separate branch; request another merge before
    // changing the readable files or deleting any old versions.
    const next = JSON.stringify([{ id: snapshot.id, clock }])
    await this.settle(doc, next)
    return next
  }
  async settle(doc: Document, expected: string) {
    const client = await accountClient(this.config)
    const meta = await this.metadata(client)
    if (revision(meta.heads) !== expected) throw new RevisionChanged()
    try { await publishFiles(client, this.config.folderId, doc) } catch (cause) {
      if (cause instanceof QuarkApiError && (cause.status === 409 || cause.status === 404)) throw new RevisionChanged()
      if (revision((await this.metadata(client)).heads) !== expected) throw new RevisionChanged()
      throw cause
    }
    if (revision((await this.metadata(client)).heads) !== expected) throw new RevisionChanged()
    // Only prune versions observed before publishing. Unseen concurrent uploads
    // are never eligible; failed cleanup is retried by the next synchronization.
    const history = [...meta.nodes.values()].filter(node => !meta.heads.includes(node))
      .sort((a, b) => weight(b.snapshot.clock) - weight(a.snapshot.clock) || a.snapshot.id.localeCompare(b.snapshot.id))
    for (const old of history.slice(retainedHistory)) for (const file of old.files) await client.deleteFile(file.fid)
    for (const node of [...meta.heads, ...history.slice(0, retainedHistory)]) for (const duplicate of node.files.slice(1)) await client.deleteFile(duplicate.fid)
  }
}
