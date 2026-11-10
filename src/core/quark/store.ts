import { canonical, readDocument, type Document, type Conflict } from '../model'
import { emptyDocument, merge } from '../merge'
import { accountClient, listAll, type QuarkConnection } from './auth'
import type { QuarkClient } from './client'

type Meta = { id: string; parents: string[]; fid: string }
type Snapshot = { format: 'page-garden-snapshot'; version: 1; id: string; parents: string[]; document: Document }
const prefix = /^pg1-([a-f0-9]{32})-(root|[a-f0-9]{32}(?:\.[a-f0-9]{32}){0,5})\.json$/
async function contentId(doc: Document, parents: string[]) {
  const bytes = new TextEncoder().encode(canonical({ document: doc, parents }))
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return [...hash].slice(0, 16).map(value => value.toString(16).padStart(2, '0')).join('')
}
function revision(ids: string[]) { return JSON.stringify([...ids].sort()) }

// New versions are independent immutable files. Concurrent saves create branches,
// so a provider without conditional PUT can never overwrite the other save.
export class QuarkStore {
  constructor(private config: QuarkConnection, private knownRevision: string | null = null) {}
  async verify() { await (await accountClient(this.config)).getAccountInfo() }
  private async metadata(client: QuarkClient) {
    const roots = (await listAll(client, '0')).filter(entry => entry.isDirectory && entry.name === '拾页收藏')
    const folderIds = new Set([this.config.folderId, ...roots.map(entry => entry.fid)])
    const nodes = new Map<string, Meta>()
    for (const folder of folderIds) for (const entry of await listAll(client, folder)) {
      const match = !entry.isDirectory && entry.name.match(prefix)
      if (!match && !entry.isDirectory && /^pg\d+-/.test(entry.name)) throw new Error('夸克收藏版本格式不兼容，请保留文件并检查备份')
      if (!match) continue
      const parents = match[2] === 'root' ? [] : match[2].split('.')
      if (new Set(parents).size !== parents.length || parents.includes(match[1])) throw new Error('夸克收藏版本关系无效，请保留文件并检查备份')
      const existing = nodes.get(match[1])
      if (existing && canonical(existing.parents) !== canonical(parents)) throw new Error('夸克收藏版本标识冲突，未覆盖任何文件')
      nodes.set(match[1], { id: match[1], parents, fid: existing?.fid ?? entry.fid })
    }
    const referenced = new Set([...nodes.values()].flatMap(node => node.parents))
    const heads = [...nodes.values()].filter(node => !referenced.has(node.id)).sort((a, b) => a.id.localeCompare(b.id))
    const remaining = new Map<string, number>(), children = new Map<string, string[]>(), depth = new Map<string, number>()
    for (const node of nodes.values()) {
      remaining.set(node.id, node.parents.length)
      for (const parent of node.parents) {
        if (!nodes.has(parent)) throw new Error('夸克收藏的历史版本尚未可见或已被移除，请稍后重试')
        children.set(parent, [...children.get(parent) ?? [], node.id])
      }
    }
    const ready = [...nodes.values()].filter(node => !node.parents.length).map(node => node.id)
    for (let index = 0; index < ready.length; index++) {
      const id = ready[index]
      depth.set(id, Math.max(0, ...nodes.get(id)!.parents.map(parent => (depth.get(parent) ?? 0) + 1)))
      for (const child of children.get(id) ?? []) {
        remaining.set(child, remaining.get(child)! - 1)
        if (!remaining.get(child)) ready.push(child)
      }
    }
    if (depth.size !== nodes.size) throw new Error('夸克收藏版本关系出现循环，未覆盖任何文件')
    return { nodes, heads, depth }
  }
  private async load(client: QuarkClient, meta: Meta): Promise<Document> {
    const text = await client.downloadFileText(meta.fid)
    if (new TextEncoder().encode(text).byteLength > 10_000_000) throw new Error('夸克收藏文件过大，请先导出并整理')
    let value: Snapshot
    try { value = JSON.parse(text) } catch { throw new Error('夸克收藏文件已损坏，原文件未被覆盖') }
    if (value?.format !== 'page-garden-snapshot' || value.version !== 1 || value.id !== meta.id || canonical(value.parents) !== canonical(meta.parents)) throw new Error('夸克收藏版本格式不兼容，原文件未被覆盖')
    // Check immutable bytes before readDocument fills in newer optional fields.
    if (await contentId(value.document, value.parents) !== value.id) throw new Error('夸克收藏内容校验失败，原文件未被覆盖')
    return readDocument(value.document)
  }
  async read(): Promise<{ doc: Document | null; etag: string | null; conflicts: Conflict[] }> {
    const client = await accountClient(this.config)
    const { nodes, heads, depth } = await this.metadata(client)
    const known: string[] = this.knownRevision ? JSON.parse(this.knownRevision) : []
    if (known.some(id => !nodes.has(id))) throw new Error('夸克的新版本尚未出现在目录列表中，请稍后重试；本地修改已保留')
    if (!heads.length) return { doc: null, etag: null, conflicts: [] }
    const cache = new Map<string, Promise<Document>>()
    const load = (id: string) => {
      if (!cache.has(id)) {
        const meta = nodes.get(id)
        if (!meta) throw new Error('夸克收藏的历史版本尚未可见或已被移除，请稍后重试')
        cache.set(id, this.load(client, meta))
      }
      return cache.get(id)!
    }
    const ancestors = (id: string): Set<string> => {
      const result = new Set<string>(), pending = [id]
      while (pending.length) {
        const value = pending.pop()!
        if (result.has(value)) continue
        result.add(value)
        pending.push(...nodes.get(value)!.parents)
      }
      return result
    }
    // Validate lineage even with one head; an incomplete listing is never empty data.
    let common = ancestors(heads[0].id)
    let doc = await load(heads[0].id)
    const conflicts: Conflict[] = []
    for (const head of heads.slice(1)) {
      const other = ancestors(head.id)
      common = new Set([...common].filter(id => other.has(id)))
      const baseId = [...common].sort((a, b) => depth.get(b)! - depth.get(a)! || a.localeCompare(b))[0]
      const result = merge(baseId ? await load(baseId) : emptyDocument(), doc, await load(head.id))
      doc = result.doc
      conflicts.push(...result.conflicts.map(conflict => ({ ...conflict, id: `${head.id}:${conflict.id}` })))
    }
    return { doc: readDocument(doc), etag: revision(heads.map(head => head.id)), conflicts }
  }
  async write(doc: Document, previous: string | null): Promise<string> {
    readDocument(doc)
    const parents: string[] = previous ? JSON.parse(previous) : []
    if (!Array.isArray(parents) || parents.length > 6 || parents.some(id => !/^[a-f0-9]{32}$/.test(id))) throw new Error('并行版本较多，请先完成现有版本的合并')
    const id = await contentId(doc, parents)
    const value: Snapshot = { format: 'page-garden-snapshot', version: 1, id, parents, document: doc }
    const bytes = new TextEncoder().encode(JSON.stringify(value))
    if (bytes.byteLength > 10_000_000) throw new Error('收藏数据超过单次上传限制，请先导出备份并整理')
    const client = await accountClient(this.config)
    const { nodes } = await this.metadata(client)
    let meta = nodes.get(id)
    if (!meta) {
      const uploaded = await client.uploadSmallFile({ parentFid: this.config.folderId, fileName: `pg1-${id}-${parents.join('.') || 'root'}.json`, bytes, mimeType: 'application/json' })
      meta = { id, parents, fid: uploaded.fid }
    }
    // Verify by fid, not a possibly stale directory listing. Never delete the old version.
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await this.load(client, meta); return revision([id]) } catch (error) {
        lastError = error
        if (attempt < 2) await new Promise(done => setTimeout(done, 400 * (attempt + 1)))
      }
    }
    throw lastError
  }
}
