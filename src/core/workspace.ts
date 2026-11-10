import { active, apply, createDocument, equal, parents, prune, readDocument, type Conflict, type Document } from './model'
import { emptyDocument, merge, refreshConflicts, resolveConflict } from './merge'
import type { ConnectRequest, Request, Result, Snapshot } from './protocol'
import { RevisionChanged } from './webdav'
import { normalizeRemote, remoteKey, remoteStore, isQuark, type Connection, type RemoteRead } from './remote'
import { startQr, pollQr } from './quark/auth'
import { quarkOrigins } from './quark/transport'
import type { LoginProgress } from './quark/progress'

type Source = { config: Connection; doc: Document; base: Document; etag: string | null; resolvedRevision?: string | null; conflicts: Conflict[]; status: Snapshot['status']; error: string; lastSync: number | null }
type Root = { active: string | null; sources: Record<string, Source> }
const storageKey = 'new-page.workspace.v1'
let chain: Promise<unknown> = Promise.resolve()
const syncing = new Set<string>()
const inFlight = new Map<string, Promise<void>>()
const scheduled = new Map<string, ReturnType<typeof setTimeout>>()

function atomic<T>(work: (root: Root) => T | Promise<T>): Promise<T> {
  const result = chain.then(async () => {
    const stored = await chrome.storage.local.get(storageKey)
    const root: Root = (stored[storageKey] as Root | undefined) ?? { active: null, sources: {} }
    const output = await work(root)
    await chrome.storage.local.set({ [storageKey]: root })
    return output
  })
  chain = result.catch(() => undefined)
  return result
}
function broadcast() { void chrome.runtime.sendMessage({ type: 'changed' }).catch(() => undefined) }
function current(root: Root, id: string) {
  if (root.active !== id || !root.sources[id]) throw new Error('数据源已切换，请在当前页面重试')
  return root.sources[id]
}
function includeCloudConflicts(local: Conflict[], cloud: Conflict[] = []) {
  return [...local, ...cloud.filter(candidate => !local.some(value => value.entityId === candidate.entityId &&
    [candidate.local, candidate.remote].every(version => equal(version, value.local) || equal(version, value.remote))))]
}
function snapshot(root: Root): Snapshot {
  const source = root.active ? root.sources[root.active] : null
  const connection: Snapshot['connection'] = source ? isQuark(source.config) ? { kind: 'quark', url: 'https://pan.quark.cn/', username: source.config.nickname } : { kind: 'webdav', url: source.config.url, username: source.config.username } : null
  return source ? { sourceId: root.active, document: source.doc, connection, status: source.conflicts.length ? 'conflict' : source.status, conflicts: source.conflicts, error: source.error, lastSync: source.lastSync } : { sourceId: null, document: null, connection: null, status: 'pending', error: '', conflicts: [], lastSync: null }
}
export function schedule(id: string, delay = 600) {
  const pending = scheduled.get(id)
  if (pending) clearTimeout(pending)
  scheduled.set(id, setTimeout(() => { scheduled.delete(id); void synchronize(id) }, delay))
}
export function synchronize(id: string): Promise<void> {
  const pending = scheduled.get(id)
  if (pending) { clearTimeout(pending); scheduled.delete(id) }
  const running = inFlight.get(id)
  if (running) return running
  const task = synchronizeSource(id).finally(() => inFlight.delete(id))
  inFlight.set(id, task)
  return task
}
async function synchronizeSource(id: string) {
  syncing.add(id)
  let retry = false
  try {
    const initial = await atomic(root => {
      const source = root.sources[id]
      if (!source || source.conflicts.length) return null
      source.doc = prune(source.doc); source.status = 'syncing'; source.error = ''
      return structuredClone(source)
    })
    if (!initial) return
    broadcast()
    const client = remoteStore(initial.config, initial.etag)
    const remote: RemoteRead = await client.read()
    const upload = await atomic(root => {
      const source = root.sources[id]
      if (!source || source.conflicts.length) return null
      // Disappearance of an established file is not a fresh empty account.
      if (!remote.doc && Object.keys(source.base.entities).length) throw new Error('远端数据文件被移除，本地数据已保留；请检查服务器后重试')
      const result = merge(source.base, source.doc, remote.doc ?? emptyDocument())
      source.doc = prune(result.doc); source.conflicts = includeCloudConflicts(result.conflicts, source.resolvedRevision === remote.etag ? [] : remote.conflicts)
      source.base = remote.doc ?? emptyDocument(); source.etag = remote.etag
      if (source.conflicts.length) { source.status = 'conflict'; return null }
      readDocument(source.doc)
      if (remote.doc && equal(source.doc, remote.doc) && !(isQuark(source.config) && remote.etag && JSON.parse(remote.etag).length > 1)) { source.status = 'synced'; source.lastSync = Date.now(); return null }
      return structuredClone(source.doc)
    })
    broadcast()
    if (!upload) return
    const etag = await client.write(upload, remote.etag)
    await atomic(root => {
      const source = root.sources[id]
      if (!source) return
      source.base = upload; source.etag = etag; source.lastSync = Date.now()
      retry = !equal(source.doc, upload)
      source.status = retry ? 'pending' : 'synced'; source.error = ''
    })
  } catch (error) {
    retry = error instanceof RevisionChanged
    await atomic(root => {
      const source = root.sources[id]
      if (source) { source.status = retry ? 'pending' : 'error'; source.error = error instanceof Error ? error.message : '同步失败，本地数据已保留' }
    })
  } finally {
    syncing.delete(id); broadcast()
    if (retry) schedule(id, 1000)
  }
}
async function connect(request: ConnectRequest): Promise<Result> {
  const config = normalizeRemote(request.config), id = await remoteKey(config)
  if (!isQuark(config) && !await chrome.permissions.contains({ origins: [new URL(config.url).origin + '/*'] })) throw new Error('未获得 WebDAV 服务器访问权限，请重新点击连接并授权')
  const knownRevision = await atomic(root => root.sources[id]?.etag ?? null)
  const client = remoteStore(config, knownRevision)
  let remote: RemoteRead
  try { await client.verify(); remote = await client.read() } catch (error) {
    const cached = await atomic(root => {
      if (request.mode !== 'switch' || !root.sources[id]) return null
      root.active = id
      root.sources[id].config = config
      root.sources[id].status = 'error'
      root.sources[id].error = error instanceof Error ? error.message : '当前离线，正在显示本地内容'
      return snapshot(root)
    })
    if (cached) { broadcast(); return { ok: true, snapshot: cached } }
    throw error
  }
  const result = await atomic(root => {
    const previous = root.active ? root.sources[root.active] : null
    if (request.mode === 'migrate' && root.active === id) throw new Error('源和目标相同，无需迁移')
    if (request.mode === 'migrate' && previous?.conflicts.length) throw new Error('请先解决当前数据源的冲突再迁移')
    if (request.mode === 'migrate' && root.sources[id]?.conflicts.length) throw new Error('目标数据源有未解决冲突，请先切换到目标并处理后再迁移')
    const cached = root.sources[id]
    if (cached && !remote.doc && Object.keys(cached.base.entities).length) throw new Error('目标远端文件被移除，未切换或覆盖数据')
    let doc = remote.doc ?? createDocument(request.nickname || (isQuark(config) ? config.nickname : '朋友')), conflicts: Conflict[] = remote.conflicts ?? []
    if (cached) {
      const combined = merge(cached.base, cached.doc, remote.doc ?? emptyDocument())
      doc = combined.doc
      conflicts = includeCloudConflicts(refreshConflicts(cached.conflicts, combined.conflicts, doc, remote.doc ?? emptyDocument()), cached.resolvedRevision === remote.etag ? [] : remote.conflicts)
    }
    if (request.mode === 'migrate' && previous) {
      if (conflicts.length) throw new Error('目标数据源有未解决冲突，请先切换到目标并处理后再迁移')
      if (remote.doc && !request.confirmed) return { ok: true, confirmation: '目标已有收藏。确认合并当前数据？已有内容会保留，冲突需要单独选择。' } as const
      if (!remote.doc && !cached) doc = structuredClone(previous.doc)
      else {
        const combined = merge(emptyDocument(), previous.doc, doc)
        doc = combined.doc; conflicts = combined.conflicts
      }
    }
    root.sources[id] = { config, doc: prune(doc), base: remote.doc ?? emptyDocument(), etag: remote.etag, resolvedRevision: cached?.resolvedRevision, conflicts, status: conflicts.length ? 'conflict' : 'pending', error: '', lastSync: cached?.lastSync ?? null }
    root.active = id
    return { ok: true, snapshot: snapshot(root) } as const
  })
  if ('snapshot' in result) { schedule(id); broadcast() }
  return result
}
export async function handle(request: Request): Promise<Result> {
  if (request.type === 'quark-qr-start' || request.type === 'quark-qr-poll') {
    const progress: LoginProgress | undefined = request.type === 'quark-qr-start' && request.traceId ? stage => {
      void chrome.runtime.sendMessage({ type: 'quark-login-stage', traceId: request.traceId, stage }).catch(() => undefined)
    } : undefined
    progress?.('permissions')
    if (!await chrome.permissions.contains({ origins: quarkOrigins, permissions: ['webRequest', 'declarativeNetRequestWithHostAccess'] })) throw new Error('请点击扫码登录并授权访问夸克网盘')
    if (request.type === 'quark-qr-poll') return { ok: true, ...await pollQr(request.id) }
    const qr = await startQr(progress)
    progress?.('responding')
    return { ok: true, qr }
  }
  if (request.type === 'connect') return connect(request)
  if (request.type === 'sync') {
    await atomic(root => current(root, request.sourceId))
    await synchronize(request.sourceId)
    return atomic(root => ({ ok: true, snapshot: snapshot(root) } as const))
  }
  const result = await atomic(root => {
    if (request.type === 'snapshot') {
      if (root.active) {
        const source = root.sources[root.active], cleaned = prune(source.doc)
        if (!equal(cleaned, source.doc)) { source.doc = cleaned; source.status = 'pending'; schedule(root.active) }
        if (source.status === 'syncing' && !syncing.has(root.active)) { source.status = 'pending'; schedule(root.active) }
      }
      return { ok: true, snapshot: snapshot(root) } as const
    }
    const source = current(root, request.sourceId)
    if (request.type === 'export') return { ok: true, backup: source.doc } as const
    if (request.type === 'action') {
      const before = source.doc
      source.doc = apply(source.doc, request.action)
      source.conflicts = source.conflicts.map(conflict => {
        const entity = source.doc.entities[conflict.entityId]
        if (equal(before.entities[conflict.entityId], entity)) return conflict
        return { ...conflict, local: structuredClone(entity), localParents: entity.parentId !== before.entities[entity.id]?.parentId ? parents(source.doc, entity) : conflict.localParents.map(parent => equal(before.entities[parent.id], source.doc.entities[parent.id]) ? parent : structuredClone(source.doc.entities[parent.id])) }
      })
    } else if (request.type === 'resolve') {
      const conflict = source.conflicts.find(c => c.id === request.conflictId)
      if (!conflict) throw new Error('此冲突已处理，请刷新')
      source.doc = resolveConflict(source.doc, conflict, request.side)
      source.conflicts = source.conflicts.filter(c => c.id !== conflict.id)
      if (!source.conflicts.length) { readDocument(source.doc); source.resolvedRevision = source.etag }
    } else if (request.type === 'import') {
      if (source.conflicts.length) throw new Error('请先解决同步冲突再导入')
      const imported = prune(readDocument(request.data))
      if (!request.confirmed && active(source.doc).some(e => e.kind === 'link')) return { ok: true, confirmation: '导入会合并备份与当前收藏，重复网址独立保留。是否继续？' } as const
      const combined = merge(emptyDocument(), source.doc, imported)
      source.doc = combined.doc; source.conflicts = combined.conflicts
    }
    source.status = source.conflicts.length ? 'conflict' : 'pending'
    source.error = ''
    schedule(request.sourceId)
    return { ok: true, snapshot: snapshot(root) } as const
  })
  if (request.type !== 'snapshot' && request.type !== 'export') broadcast()
  return result
}
export async function resume() {
  const ids = await atomic(root => Object.keys(root.sources))
  // Every source is bound to its own credentials and pending operations, even after a switch.
  for (const id of ids) schedule(id, 100)
}
