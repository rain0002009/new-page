import { active, apply, createDocument, equal, isActive, parents, prune, readDocument, type Conflict, type Document } from './model'
import { emptyDocument, merge, refreshConflicts, resolveConflict } from './merge'
import type { ConnectRequest, Request, Result } from './protocol'
import { RevisionChanged } from './webdav'
import { normalizeRemote, remoteKey, remoteStore, isQuark, type Connection, type RemoteRead } from './remote'
import { startQr, pollQr, repairFolder, accountClient } from './quark/auth'
import { QuarkStore } from './quark/store'
import { uploadBookToQuark } from './quark/epub-files'
import { quarkOrigins } from './quark/transport'
import type { LoginProgress } from './quark/progress'
import { ensureLocalWorkspace, storageKey, workspaceSnapshot as snapshot, type StoredWorkspace as Root, type WorkspaceSource } from './local-workspace'
import { configureMarkdownNavigation, openOriginalMarkdown } from './markdown-navigation'
import { queueDocumentImageChanges, updateLocalImageDocument } from './hosted-images'
import { executeImageCleanup } from './hosted-image-cleaner'
import { normalizeImageUrl } from './image-references'
import { getBookBytes, putBookBytes } from './epub-storage'
import { executeBookCleanup, queueBookChanges } from './book-cleaner'

let chain: Promise<unknown> = Promise.resolve()
let bookUploadChain: Promise<unknown> = Promise.resolve()
const syncing = new Set<string>()
const inFlight = new Map<string, Promise<void>>()
const scheduled = new Map<string, ReturnType<typeof setTimeout>>()

function atomic<T>(work: (root: Root) => T | Promise<T>): Promise<T> {
  const result = chain.then(async () => {
    const stored = await chrome.storage.local.get(storageKey)
    const root: Root = (stored[storageKey] as Root | undefined) ?? { active: null, sources: {} }
    ensureLocalWorkspace(root)
    const output = await work(root)
    await chrome.storage.local.set({ [storageKey]: root })
    return output
  })
  chain = result.catch(() => undefined)
  return result
}
function broadcast() { void chrome.runtime.sendMessage({ type: 'changed' }).catch(() => undefined) }
function cleanupImages(id: string): Promise<unknown> {
  return executeImageCleanup(id, atomic, broadcast)
}
function cleanupBooks(id: string): Promise<unknown> {
  return executeBookCleanup(id, atomic)
}
function current(root: Root, id: string) {
  if (root.active !== id || !root.sources[id]) throw new Error('数据源已切换，请在当前页面重试')
  return root.sources[id]
}
function includeCloudConflicts(local: Conflict[], cloud: Conflict[] = []) {
  return [...local, ...cloud.filter(candidate => !local.some(value => value.entityId === candidate.entityId &&
    [candidate.local, candidate.remote].every(version => equal(version, value.local) || equal(version, value.remote))))]
}
function acknowledgeNotes(source: WorkspaceSource, attempted: string[], synced: Document) {
  const completed = new Set(attempted)
  source.pendingNoteIds = source.pendingNoteIds?.filter(id => !completed.has(id) ||
    !equal(source.doc.entities[id], synced.entities[id]) ||
    (source.doc.entities[id] && isActive(source.doc, source.doc.entities[id])) !== (synced.entities[id] && isActive(synced, synced.entities[id])))
}
function queueNoteChanges(source: WorkspaceSource, before: Document) {
  if (!source.config || !isQuark(source.config)) return
  const pending = new Set(source.pendingNoteIds)
  for (const id of new Set([...Object.keys(before.entities), ...Object.keys(source.doc.entities)])) {
    const previous = before.entities[id], note = source.doc.entities[id]
    if (previous?.kind !== 'note' && note?.kind !== 'note') continue
    const wasActive = !!(previous && isActive(before, previous)), nowActive = !!(note && isActive(source.doc, note))
    if (wasActive !== nowActive || (nowActive && note?.kind === 'note' &&
      (previous?.kind !== 'note' || previous.title !== note.title || previous.body !== note.body))) pending.add(id)
  }
  source.pendingNoteIds = [...pending]
}
export function schedule(id: string, delay = 600) {
  const pending = scheduled.get(id)
  if (pending) clearTimeout(pending)
  scheduled.set(id, setTimeout(() => {
    scheduled.delete(id)
    void atomic(root => root.sources[id]?.config).then(config => {
      if (!config) { void cleanupImages(id); void cleanupBooks(id) }
      else void synchronize(id)
    })
  }, delay))
}
export function synchronize(id: string, repairing = false): Promise<void> {
  const pending = scheduled.get(id)
  if (pending) { clearTimeout(pending); scheduled.delete(id) }
  const running = inFlight.get(id)
  if (running) return repairing ? Promise.reject(new Error('正在同步，请稍后重试修复')) : running
  const task = synchronizeSource(id, repairing).finally(() => inFlight.delete(id))
  inFlight.set(id, task)
  return task
}
async function synchronizeSource(id: string, repairing = false) {
  syncing.add(id)
  let retry = false
  try {
    const initial = await atomic(root => {
      const source = root.sources[id]
      if (!source || !source.config || source.conflicts.length) return null
      if (repairing) {
        if (!isQuark(source.config)) throw new Error('只有夸克收藏库支持此修复操作')
        source.pendingNoteIds = [...new Set([...(source.pendingNoteIds ?? []), ...Object.values(source.doc.entities).filter(entity => entity.kind === 'note').map(entity => entity.id)])]
      }
      const before = source.doc
      source.doc = prune(source.doc)
      queueDocumentImageChanges(root, id, before, source.doc)
      queueBookChanges(root, id, before, source.doc)
      source.status = 'syncing'; source.error = ''
      return structuredClone(source)
    })
    if (!initial || !initial.config) {
      await cleanupImages(id)
      await cleanupBooks(id)
      return
    }
    broadcast()
    if (repairing && isQuark(initial.config)) {
      const previousFolderId = initial.config.folderId
      const config = await repairFolder(initial.config)
      if (config.folderId !== previousFolderId) {
        await atomic(root => {
          const source = root.sources[id]
          if (!source || !isQuark(source.config) || source.config.accountId !== config.accountId || source.config.folderId !== previousFolderId) throw new Error('数据源已变更，请重试修复')
          source.config = config
          source.etag = null
          delete source.resolvedRevision
        })
        initial.config = config
        initial.etag = null
      }
    }
    const client = repairing && isQuark(initial.config) ? new QuarkStore(initial.config, initial.etag, initial.pendingNoteIds, true) : remoteStore(initial.config, initial.etag, initial.pendingNoteIds)
    const remote: RemoteRead = await client.read()
    let unchanged: Document | null = null
    const upload = await atomic(root => {
      const source = root.sources[id]
      if (!source || source.conflicts.length) return null
      // Disappearance of an established file is not a fresh empty account.
      if (!repairing && !remote.doc && Object.keys(source.base.entities).length) throw new Error('远端数据文件被移除，本地数据已保留；请检查服务器后重试')
      const result = merge(repairing && !remote.doc ? emptyDocument() : source.base, source.doc, remote.doc ?? emptyDocument())
      const before = source.doc
      source.doc = prune(result.doc); source.conflicts = includeCloudConflicts(result.conflicts, source.resolvedRevision === remote.etag ? [] : remote.conflicts)
      queueDocumentImageChanges(root, id, before, source.doc)
      queueBookChanges(root, id, before, source.doc)
      source.base = remote.doc ?? emptyDocument(); source.etag = remote.etag
      if (source.conflicts.length) { source.status = 'conflict'; return null }
      readDocument(source.doc)
      if (remote.doc && equal(source.doc, remote.doc)) { unchanged = structuredClone(source.doc); return null }
      return structuredClone(source.doc)
    })
    broadcast()
    if (!upload) {
      if (unchanged) {
        const etag = 'settle' in client && remote.etag ? await client.settle(unchanged, remote.etag) : remote.etag
        await atomic(root => {
          const source = root.sources[id]
          if (source) {
            acknowledgeNotes(source, initial.pendingNoteIds ?? [], unchanged!)
            source.etag = etag
            retry = !equal(source.doc, unchanged) || !!source.pendingNoteIds?.length
            source.status = retry ? 'pending' : 'synced'; source.lastSync = Date.now()
          }
        })
      }
      return
    }
    const etag = await client.write(upload, remote.etag)
    await atomic(root => {
      const source = root.sources[id]
      if (!source) return
      source.base = upload; source.etag = etag; source.lastSync = Date.now()
      acknowledgeNotes(source, initial.pendingNoteIds ?? [], upload)
      retry = !equal(source.doc, upload) || !!source.pendingNoteIds?.length
      source.status = retry ? 'pending' : 'synced'; source.error = ''
    })
  } catch (error) {
    retry = !repairing && error instanceof RevisionChanged
    await atomic(root => {
      const source = root.sources[id]
      if (source) { source.status = retry ? 'pending' : 'error'; source.error = error instanceof Error ? error.message : '同步失败，本地数据已保留' }
    })
  } finally {
    syncing.delete(id); broadcast()
    if (retry) schedule(id, 1000)
    else { await cleanupImages(id); await cleanupBooks(id) }
  }
}
function hasLocalContent(previous: WorkspaceSource | null | undefined): boolean {
  if (!previous) return false
  const list = active(previous.doc)
  if (list.some(e => e.kind === 'link' || e.kind === 'note' || e.kind === 'book' || e.kind === 'share')) return true
  const spaces = list.filter(e => e.kind === 'space')
  const collections = list.filter(e => e.kind === 'collection')
  if (spaces.length !== 1 || spaces[0].title !== '我的空间') return true
  if (collections.length !== 1 || collections[0].title !== '日常收藏') return true
  return false
}

async function connect(request: ConnectRequest): Promise<Result> {
  const config = normalizeRemote(request.config)
  const defaultId = await remoteKey(config)
  const id = isQuark(config) ? await atomic(root => Object.keys(root.sources).find(id => {
    const saved = root.sources[id].config
    return isQuark(saved) && saved.folderId === config.folderId
  }) ?? defaultId) : defaultId
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
    const fromLocal = !previous || !previous.config
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
    const beforeMigration = doc
    const hasLocalItems = hasLocalContent(previous)
    if (fromLocal && previous) {
      if (hasLocalItems) {
        if (remote.doc && !request.confirmed) return { ok: true, confirmation: '目标已有收藏。确认合并当前数据？已有内容会保留，冲突需要单独选择。' } as const
        if (!remote.doc && !cached) doc = structuredClone(previous.doc)
        else {
          const combined = merge(emptyDocument(), previous.doc, doc)
          doc = combined.doc; conflicts = combined.conflicts
        }
      } else {
        if (!remote.doc && !cached) doc = structuredClone(previous.doc)
      }
    } else if (request.mode === 'migrate' && previous) {
      if (conflicts.length) throw new Error('目标数据源有未解决冲突，请先切换到目标并处理后再迁移')
      if (remote.doc && !request.confirmed) return { ok: true, confirmation: '目标已有收藏。确认合并当前数据？已有内容会保留，冲突需要单独选择。' } as const
      if (!remote.doc && !cached) doc = structuredClone(previous.doc)
      else {
        const combined = merge(emptyDocument(), previous.doc, doc)
        doc = combined.doc; conflicts = combined.conflicts
      }
    }
    root.sources[id] = { config, doc: prune(doc), base: remote.doc ?? emptyDocument(), etag: remote.etag, resolvedRevision: cached?.resolvedRevision, pendingNoteIds: cached?.pendingNoteIds, conflicts, status: conflicts.length ? 'conflict' : 'pending', error: '', lastSync: cached?.lastSync ?? null }
    queueDocumentImageChanges(root, id, doc, root.sources[id].doc)
    queueBookChanges(root, id, doc, root.sources[id].doc)
    if (cached) queueDocumentImageChanges(root, id, cached.doc, root.sources[id].doc)
    if (fromLocal || request.mode === 'migrate') queueNoteChanges(root.sources[id], beforeMigration)
    if (fromLocal && root.active === 'local' && id !== 'local') delete root.sources['local']
    root.active = id
    return { ok: true, snapshot: snapshot(root) } as const
  })
  if ('snapshot' in result) { schedule(id); broadcast() }
  return result
}
export async function handle(request: Request, tabId?: number): Promise<Result> {
  if (request.type === 'uploaded-image') {
    await atomic(root => {
      if (!root.sources[request.sourceId]) throw new Error('上传来源已不存在，无法登记图片清理信息')
      const url = normalizeImageUrl(request.url)
      if (!url || !/^[a-f0-9]{64}$/.test(request.credential)) throw new Error('图片上传记录无效')
      root.imageOwners ??= {}
      root.imageOwners[url] = { sourceId: request.sourceId, credential: request.credential, hash: request.hash, revision: crypto.randomUUID() }
    })
    return { ok: true }
  }
  if (request.type === 'local-image-document') {
    await atomic(root => {
      updateLocalImageDocument(root, request.id, request.body, request.previous, request.sourceId)
      for (const alias of request.aliases ?? []) if (alias !== request.id && root.imageDocuments) delete root.imageDocuments[alias]
    })
    if (request.previous !== undefined) {
      const ids = await atomic(root => [...new Set(root.imageCleanup?.map(job => job.sourceId))])
      for (const id of ids) schedule(id)
    }
    return { ok: true }
  }
  if (request.type === 'markdown-takeover') { await configureMarkdownNavigation(request.enabled); return { ok: true } }
  if (request.type === 'open-original') { await openOriginalMarkdown(request.url, tabId); return { ok: true } }
  if (request.type === 'read-markdown') {
    const url = new URL(request.url)
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) throw new Error('此地址不支持 Markdown 阅读')
    try {
      const response = await fetch(url.href, { credentials: 'omit', signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`读取失败（${response.status}），请重试或打开原网页`)
      const body = await response.text()
      if (/text\/html|application\/xhtml/i.test(response.headers.get('content-type') ?? '') || /^\s*(?:<!doctype\s+html|<html[\s>])/i.test(body)) {
        if (url.protocol === 'file:') throw new Error('此地址不是 Markdown，请打开原网页')
        return { ok: true, originalUrl: url.href }
      }
      return { ok: true, file: { body, url: response.url || url.href } }
    } catch (cause) {
      if (url.protocol === 'file:') throw new Error('无法读取本地地址，请在扩展详情启用「允许访问文件网址」，或将文件拖入新标签页')
      throw cause
    }
  }
  if (request.type === 'note-editor') {
    if (tabId === undefined) throw new Error('请在文档标签页编辑')
    const key = `${request.sourceId}:${request.id}`
    const previous = await atomic(root => root.editors?.[key])
    let alive = false
    if (previous) {
      try {
        const tab = await chrome.tabs.get(previous.tabId)
        const url = new URL(tab.pendingUrl ?? tab.url ?? '')
        alive = url.href.startsWith(chrome.runtime.getURL('document/index.html')) && url.searchParams.get('note') === request.id && url.searchParams.get('source') === request.sourceId
      } catch { /* Closed tabs and pages that navigated away release editing. */ }
    }
    if (alive && previous!.tabId !== tabId && request.takeover) {
      const flushed = await chrome.tabs.sendMessage(previous!.tabId, { type: 'note-flush', sourceId: request.sourceId, id: request.id, token: previous!.token }).catch(() => null) as { saved?: boolean } | null
      if (!flushed?.saved) throw new Error('原编辑页尚有未保存内容，请先回到该页保存或导出，再接管')
    }
    return atomic(root => {
      const source = current(root, request.sourceId)
      const note = active(source.doc).find(e => e.id === request.id && e.kind === 'note')
      if (!note) throw new Error('笔记已删除，无法编辑')
      const owner = root.editors?.[key]
      if (owner && owner.tabId !== tabId && (owner.token !== previous?.token || (alive && !request.takeover))) return { ok: true, editor: false }
      root.editors ??= {}; root.editors[key] = { tabId, token: request.token }
      return { ok: true, editor: true }
    })
  }
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
  if (request.type === 'disconnect') {
    const result = await atomic(root => {
      const currentSource = current(root, request.sourceId)
      root.sources['local'] = {
        config: null,
        doc: structuredClone(currentSource.doc),
        base: emptyDocument(),
        etag: null,
        conflicts: [],
        status: 'local',
        error: '',
        lastSync: null,
      }
      root.active = 'local'
      if (request.sourceId !== 'local') {
        delete root.sources[request.sourceId]
      }
      return { ok: true, snapshot: snapshot(root) } as const
    })
    broadcast()
    return result
  }
  if (request.type === 'quark-repair') {
    await atomic(root => {
      const source = current(root, request.sourceId)
      if (!source.config || !isQuark(source.config)) throw new Error('只有夸克收藏库支持此修复操作')
      if (source.conflicts.length) throw new Error('请先处理同步冲突再修复')
    })
    await synchronize(request.sourceId, true)
    return atomic(root => {
      const source = current(root, request.sourceId)
      if (source.status === 'error') throw new Error(source.error || '修复失败，请重试；本地数据已保留')
      return { ok: true, snapshot: snapshot(root) } as const
    })
  }
  if (request.type === 'sync') {
    const source = await atomic(root => current(root, request.sourceId))
    if (!source.config) return atomic(root => ({ ok: true, snapshot: snapshot(root) } as const))
    await synchronize(request.sourceId)
    return atomic(root => ({ ok: true, snapshot: snapshot(root) } as const))
  }
  if (request.type === 'upload-book-quark') {
    const task = bookUploadChain.catch(() => undefined).then(async () => {
      const info = await atomic(root => {
        const source = current(root, request.sourceId)
        if (!source.config || !isQuark(source.config)) throw new Error('请先在设置中连接夸克网盘')
        const book = source.doc.entities[request.bookId]
        if (!book || book.kind !== 'book' || !isActive(source.doc, book)) throw new Error('电子书已不存在')
        return { config: source.config, book: { id: book.id, title: book.title } }
      })
      const bytes = await getBookBytes(info.book.id)
      if (!bytes) throw new Error('未找到本机电子书文件，请重新拖入后重试')
      const uploaded = await uploadBookToQuark(await accountClient(info.config), info.config.folderId, info.book, bytes)
      const result = await atomic(root => {
        const source = current(root, request.sourceId)
        const book = source.doc.entities[info.book.id]
        if (!book || book.kind !== 'book' || !isActive(source.doc, book)) throw new Error('电子书在上传期间已被删除')
        source.doc = apply(source.doc, {
          type: 'edit',
          id: book.id,
          patch: { storage: 'quark', quarkFid: uploaded.fid },
        })
        source.status = source.conflicts.length ? 'conflict' : 'pending'
        source.error = ''
        schedule(request.sourceId)
        return { ok: true, snapshot: snapshot(root) } as const
      })
      broadcast()
      return result
    })
    bookUploadChain = task
    return task
  }
  if (request.type === 'download-book-quark') {
    const info = await atomic(root => {
      const source = current(root, request.sourceId)
      if (!source.config || !isQuark(source.config)) throw new Error('请先在设置中连接夸克网盘，以读取云端电子书')
      const book = source.doc.entities[request.bookId]
      if (!book || book.kind !== 'book' || !isActive(source.doc, book)) throw new Error('电子书已删除或不存在')
      if (book.storage !== 'quark' || !book.quarkFid) throw new Error('该电子书仅保存在原设备本地，未上传到夸克网盘')
      return { config: source.config, id: book.id, fid: book.quarkFid }
    })
    const bytes = await (await accountClient(info.config)).downloadFileBytes(info.fid)
    await putBookBytes(info.id, bytes)
    return { ok: true }
  }
  const result = await atomic(root => {
    if (request.type === 'snapshot') {
      if (root.active) {
        const source = root.sources[root.active], cleaned = prune(source.doc)
        if (!equal(cleaned, source.doc)) { const before = source.doc; source.doc = cleaned; queueDocumentImageChanges(root, root.active, before, cleaned); queueBookChanges(root, root.active, before, cleaned); source.status = 'pending'; schedule(root.active) }
        if (source.status === 'syncing' && !syncing.has(root.active)) { source.status = 'pending'; schedule(root.active) }
      }
      return { ok: true, snapshot: snapshot(root) } as const
    }
    const source = current(root, request.sourceId)
    if (request.type === 'export') return { ok: true, backup: source.doc } as const
    const before = source.doc
    if (request.type === 'action' || request.type === 'save-note') {
      if (request.type === 'save-note') {
        const owner = root.editors?.[`${request.sourceId}:${request.id}`]
        if (!owner || owner.tabId !== tabId || owner.token !== request.token) throw new Error('编辑权已交接，当前草稿已保留，可导出后在新编辑页继续')
      } else if (request.action.type === 'edit' && source.doc.entities[request.action.id]?.kind === 'note') throw new Error('请在拥有编辑权的文档页修改笔记')
      source.doc = apply(source.doc, request.type === 'save-note' ? { type: 'edit', id: request.id, patch: { title: request.title, body: request.body } } : request.action)
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
      if (!request.confirmed && active(source.doc).some(e => e.kind === 'link' || e.kind === 'note' || e.kind === 'book')) return { ok: true, confirmation: '导入会合并备份与当前收藏，重复网址独立保留。是否继续？' } as const
      const combined = merge(emptyDocument(), source.doc, imported)
      source.doc = combined.doc; source.conflicts = combined.conflicts
    }
    queueNoteChanges(source, before)
    queueDocumentImageChanges(root, request.sourceId, before, source.doc)
    queueBookChanges(root, request.sourceId, before, source.doc)
    const isOnlyCollapsed = request.type === 'action' && request.action.type === 'edit' && Object.keys(request.action.patch).length === 1 && 'collapsed' in request.action.patch
    if (!isOnlyCollapsed) {
      source.status = source.conflicts.length ? 'conflict' : 'pending'
      source.error = ''
      schedule(request.sourceId)
    }
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
