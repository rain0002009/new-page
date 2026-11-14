import { test, expect } from '@playwright/test'
import { QuarkClient } from '../src/core/quark/client'
import { QuarkStore } from '../src/core/quark/store'
import { RevisionChanged } from '../src/core/webdav'
import { createHash } from 'node:crypto'
import { apply, createDocument } from '../src/core/model'
import type { QuarkEntry } from '../src/core/quark/types'
import { handle, synchronize } from '../src/core/workspace'
import { storageKey, type StoredWorkspace } from '../src/core/local-workspace'
import { imageCredential } from '../src/core/hosted-images'

type StoredFile = QuarkEntry & { body: string }
const config = { kind: 'quark', accountId: 'test-account', folderId: 'root', nickname: 'Rain' } as const
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
const originalFetch = globalThis.fetch
const originals = {
  getAccountInfo: QuarkClient.prototype.getAccountInfo,
  listDirectory: QuarkClient.prototype.listDirectory,
  downloadFileText: QuarkClient.prototype.downloadFileText,
  uploadSmallFile: QuarkClient.prototype.uploadSmallFile,
  createDirectory: QuarkClient.prototype.createDirectory,
  renameFile: QuarkClient.prototype.renameFile,
  deleteFile: QuarkClient.prototype.deleteFile,
}
const files = new Map<string, StoredFile>()
const downloads = new Map<string, number>()
const markdownDownloads: string[] = []
const listings: string[] = []
const stored: Record<string, unknown> = {}

test.beforeEach(() => {
  files.clear(); downloads.clear(); listings.length = 0; markdownDownloads.length = 0
  for (const key of Object.keys(stored)) delete stored[key]
  stored['new-page.quark.auth.v1'] = { accounts: { 'test-account': 'synthetic-cookie' } }
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage: async () => undefined }, storage: { local: {
    get: async (key: string) => ({ [key]: stored[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(stored, values) },
  } } } })
  QuarkClient.prototype.getAccountInfo = async () => ({ nickname: 'Rain' })
  QuarkClient.prototype.listDirectory = async parent => { listings.push(parent); return [...files.values()].filter(file => file.parentFid === parent).map(({ body, ...entry }) => ({ ...entry })) }
  QuarkClient.prototype.downloadFileText = async fid => {
    downloads.set(fid, (downloads.get(fid) ?? 0) + 1)
    const file = files.get(fid)
    if (!file) throw new Error('file missing')
    if (files.get(file.parentFid)?.name === '笔记') markdownDownloads.push(fid)
    return file.body
  }
  QuarkClient.prototype.createDirectory = async (parentFid, name) => {
    const fid = crypto.randomUUID()
    files.set(fid, { fid, parentFid, name, isDirectory: true, size: 0, body: '' })
    return fid
  }
  QuarkClient.prototype.uploadSmallFile = async ({ parentFid, fileName, bytes }) => {
    const fid = crypto.randomUUID()
    files.set(fid, { fid, parentFid, name: fileName, size: bytes.byteLength, isDirectory: false, body: new TextDecoder().decode(bytes) })
    return { created: true, fid }
  }
  QuarkClient.prototype.renameFile = async (fid, name) => { files.get(fid)!.name = name }
  QuarkClient.prototype.deleteFile = async fid => {
    for (const file of files.values()) if (file.parentFid === fid) await QuarkClient.prototype.deleteFile(file.fid)
    files.delete(fid)
  }
})

test.afterEach(() => {
  Object.assign(QuarkClient.prototype, originals)
  globalThis.fetch = originalFetch
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
  else Reflect.deleteProperty(globalThis, 'chrome')
})

async function save(doc = createDocument('Rain'), noteIds: string[] = []) {
  const store = new QuarkStore(config, null, noteIds)
  const remote = await store.read()
  return { doc, etag: await store.write(doc, remote.etag) }
}
function current() { return [...files.values()].find(file => file.name === '收藏.json')! }
function clearCounts() { downloads.clear(); listings.length = 0 }
async function unchanged(etag: string) {
  const store = new QuarkStore(config, etag)
  const remote = await store.read()
  await store.settle(remote.doc!, remote.etag!)
}
function withNotes(count: number, doc = createDocument('Rain')) {
  const parentId = Object.values(doc.entities).find(entity => entity.kind === 'collection')!.id
  for (let index = 0; index < count; index++) {
    const id = 'note-' + index
    doc = apply(doc, { type: 'add-note', parentId, id })
    doc = apply(doc, { type: 'edit', id, patch: { title: '笔记' + index, body: '正文' + index } })
  }
  return doc
}
function localWorkspace(doc: ReturnType<typeof createDocument>, etag: string | null) {
  const root: StoredWorkspace = { active: 'source', sources: { source: { config, doc, base: doc, etag, conflicts: [], status: 'synced', error: '', lastSync: null } } }
  stored[storageKey] = root
  return root
}

const cleanupImageUrl = 'https://images.example.test/cleanup.png'
const cleanupImageBody = `正文\n\n![图片](${cleanupImageUrl})`
function imageCleanupDocument(count = 1) {
  let doc = apply(withNotes(count), { type: 'edit', id: 'profile', patch: { seeApiKey: 'cleanup-test-key' } })
  for (let index = 0; index < count; index++) doc = apply(doc, { type: 'edit', id: `note-${index}`, patch: { body: cleanupImageBody } })
  return doc
}
function mockImageCleanupService(options: { failDelete?: () => boolean; networkFailure?: () => boolean; historyAbsent?: () => boolean; onRequest?: (path: string) => void } = {}) {
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.origin !== 'https://s.ee') throw new Error('Unexpected network request in image cleanup test')
    expect(init?.method).toBe('GET')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer cleanup-test-key')
    calls.push(url.pathname + url.search)
    options.onRequest?.(url.pathname)
    if (url.pathname === '/api/v1/files') return Response.json({ code: 200, success: true, data: !options.historyAbsent?.() && url.searchParams.get('page') === '1' ? [{ url: cleanupImageUrl, hash: 'cleanup-hash' }] : [] })
    if (url.pathname === '/api/v1/file/delete/cleanup-hash') {
      if (options.networkFailure?.()) throw new Error('Synthetic response loss after remote deletion')
      if (options.failDelete?.()) return Response.json({ success: false }, { status: 503 })
      return Response.json({ success: true, code: '200' })
    }
    throw new Error('Unexpected s.ee API request in image cleanup test')
  }
  return calls
}
function expireImageCleanup(root: StoredWorkspace) {
  for (const job of root.imageCleanup ?? []) job.notBefore = 0
}

test('图片清理：正文保存后排持久任务，宽限期不删除，到期且同步成功后删除', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  const calls = mockImageCleanupService({ onRequest: () => {
    const cloud = JSON.parse(current().body)
    expect(cloud.entities['note-0'].body).toBe('移除了图片')
  } })
  await handle({ type: 'note-editor', sourceId: 'source', id: 'note-0', token: 'image-editor' }, 7)
  await handle({ type: 'save-note', sourceId: 'source', id: 'note-0', token: 'image-editor', title: '笔记0', body: '移除了图片' }, 7)
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.imageCleanup?.[0]).toMatchObject({ sourceId: 'source', url: cleanupImageUrl })
  expect(root.imageCleanup?.[0].notBefore).toBeGreaterThan(Date.now())
  await synchronize('source')
  expect(calls).toEqual([])
  // Rehydrate the persisted root to exercise processing independently of the editor.
  const restarted = structuredClone(root)
  stored[storageKey] = restarted
  expireImageCleanup(restarted)
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/files?page=1', '/api/v1/files?page=2', '/api/v1/file/delete/cleanup-hash'])
  expect(restarted.imageCleanup).toEqual([])
  expect(restarted.sources.source.status).toBe('synced')
})

test('图片清理：单篇笔记永久删除后清理原图，删除失败保留任务并在后续同步重试', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  let failing = true
  const calls = mockImageCleanupService({ failDelete: () => failing })
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expect(root.sources.source.doc.entities['note-0'].purged).toBe(true)
  expect(root.imageCleanup).toHaveLength(1)
  expireImageCleanup(root)
  await synchronize('source')
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.sources.source.status).toBe('error')
  expect(root.sources.source.error).toContain('图床图片清理未完成')
  failing = false
  await synchronize('source')
  expect(calls.filter(path => path.includes('/file/delete/'))).toHaveLength(2)
  expect(root.imageCleanup).toEqual([])
  expect(root.sources.source.status).toBe('synced')
})

test('图片清理：其他笔记及回收站仍有同图引用时不删除，永久清空后才删除', async () => {
  const { doc, etag } = await save(imageCleanupDocument(2), ['note-0', 'note-1'])
  const root = localWorkspace(doc, etag)
  const calls = mockImageCleanupService()
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual([])
  const collection = Object.values(root.sources.source.doc.entities).find(entity => entity.kind === 'collection')!
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: collection.id } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual([])
  await handle({ type: 'action', sourceId: 'source', action: { type: 'empty-trash' } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toContain('/api/v1/file/delete/cleanup-hash')
  expect(root.imageCleanup).toEqual([])
})

test('图片清理：本地文档登记保护引用，成功写回后的差异才进入清理队列', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  const calls = mockImageCleanupService()
  await handle({ type: 'local-image-document', id: 'local-file', body: cleanupImageBody })
  expect(root.imageDocuments?.['local-file'].urls).toEqual([cleanupImageUrl])
  expect(root.imageCleanup).toBeUndefined()
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual([])
  await handle({ type: 'local-image-document', id: 'local-file', previous: cleanupImageBody, body: '写回后的本地正文' })
  expect(root.imageDocuments?.['local-file'].urls).toEqual([])
  expect(root.imageCleanup).toHaveLength(1)
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toContain('/api/v1/file/delete/cleanup-hash')
  expect(root.imageCleanup).toEqual([])
})

test('图片清理：上传 RPC 保存归属和删除凭据，命中缓存时直接删除而不查询历史', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  const calls = mockImageCleanupService()
  const credential = imageCredential('cleanup-test-key')
  await handle({ type: 'uploaded-image', sourceId: 'source', url: cleanupImageUrl + '#preview', credential, hash: 'cleanup-hash' })
  expect(root.imageOwners?.[cleanupImageUrl]).toMatchObject({ sourceId: 'source', credential, hash: 'cleanup-hash' })
  expect(root.imageOwners?.[cleanupImageUrl]?.revision).toEqual(expect.any(String))
  expect(root.imageOwners?.[cleanupImageUrl + '#preview']).toBeUndefined()
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expect(root.imageCleanup?.[0].credential).toBe(credential)
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/file/delete/cleanup-hash'])
  expect(root.imageCleanup).toEqual([])
  expect(root.imageOwners?.[cleanupImageUrl]).toBeUndefined()
})

test('图片清理：上传后切换收藏库，本地移图仍归原来源且其他来源引用继续保护', async () => {
  const initial = apply(createDocument('Rain'), { type: 'edit', id: 'profile', patch: { seeApiKey: 'cleanup-test-key' } })
  const { doc, etag } = await save(initial)
  const root = localWorkspace(doc, etag)
  const credential = imageCredential('cleanup-test-key')
  await handle({ type: 'uploaded-image', sourceId: 'source', url: cleanupImageUrl, credential, hash: 'cleanup-hash' })
  await handle({ type: 'local-image-document', id: 'local-source-a', sourceId: 'source', body: cleanupImageBody })
  const otherDoc = apply(imageCleanupDocument(), { type: 'edit', id: 'profile', patch: { seeApiKey: 'other-account-key' } })
  root.sources.other = { ...root.sources.source, doc: otherDoc, base: structuredClone(otherDoc) }
  root.active = 'other'
  const calls = mockImageCleanupService()
  await handle({ type: 'local-image-document', id: 'local-source-a', sourceId: 'source', previous: cleanupImageBody, body: '本地图片已移除' })
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.imageCleanup?.[0]).toMatchObject({ sourceId: 'source', url: cleanupImageUrl, credential })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual([])
  root.sources.other.doc = apply(root.sources.other.doc, { type: 'edit', id: 'note-0', patch: { body: '其他收藏库也移除了图片' } })
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/file/delete/cleanup-hash'])
  expect(root.imageCleanup).toEqual([])
  expect(root.active).toBe('other')
})

test('图片清理：替换 Key 时保留任务并显示错误，恢复原 Key 后重试缓存删除', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  const calls = mockImageCleanupService()
  await handle({ type: 'uploaded-image', sourceId: 'source', url: cleanupImageUrl, credential: imageCredential('cleanup-test-key'), hash: 'cleanup-hash' })
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  await handle({ type: 'action', sourceId: 'source', action: { type: 'edit', id: 'profile', patch: { seeApiKey: 'replacement-account-key' } } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual([])
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.sources.source.status).toBe('error')
  expect(root.sources.source.error).toContain('API Key 已变更')
  await handle({ type: 'action', sourceId: 'source', action: { type: 'edit', id: 'profile', patch: { seeApiKey: 'cleanup-test-key' } } })
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/file/delete/cleanup-hash'])
  expect(root.imageCleanup).toEqual([])
  expect(root.sources.source.status).toBe('synced')
})

test('图片清理：缓存删除响应丢失后丢弃 hash，下轮查询历史确认已不存在才清任务', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  let responseLost = true
  const calls = mockImageCleanupService({ networkFailure: () => responseLost, historyAbsent: () => !responseLost })
  await handle({ type: 'uploaded-image', sourceId: 'source', url: cleanupImageUrl, credential: imageCredential('cleanup-test-key'), hash: 'cleanup-hash' })
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/file/delete/cleanup-hash'])
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.imageOwners?.[cleanupImageUrl]?.hash).toBeUndefined()
  expect(root.sources.source.status).toBe('error')
  responseLost = false
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/file/delete/cleanup-hash', '/api/v1/files?page=1'])
  expect(root.imageCleanup).toEqual([])
  expect(root.sources.source.status).toBe('synced')
})

test('图片清理：旧删除响应返回时保留同地址新上传记录和新版本清理任务', async () => {
  const { doc, etag } = await save(imageCleanupDocument(), ['note-0'])
  const root = localWorkspace(doc, etag)
  const credential = imageCredential('cleanup-test-key')
  await handle({ type: 'uploaded-image', sourceId: 'source', url: cleanupImageUrl, credential, hash: 'cleanup-hash' })
  const oldOwnerRevision = root.imageOwners![cleanupImageUrl].revision
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expireImageCleanup(root)
  const oldJobRevision = root.imageCleanup![0].revision
  let releaseResponse!: () => void
  let reportStarted!: () => void
  const responseReady = new Promise<void>(resolve => { releaseResponse = resolve })
  const requestStarted = new Promise<void>(resolve => { reportStarted = resolve })
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    expect(url.origin).toBe('https://s.ee')
    expect(url.pathname).toBe('/api/v1/file/delete/cleanup-hash')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer cleanup-test-key')
    calls.push(url.pathname)
    reportStarted()
    await responseReady
    return Response.json({ success: true, code: '200' })
  }
  const syncing = synchronize('source')
  await requestStarted
  await handle({ type: 'uploaded-image', sourceId: 'source', url: cleanupImageUrl, credential, hash: 'new-upload-hash' })
  await handle({ type: 'local-image-document', id: 'replacement-file', sourceId: 'source', previous: cleanupImageBody, body: '新上传的图也已移除' })
  const newOwnerRevision = root.imageOwners![cleanupImageUrl].revision
  const newJobRevision = root.imageCleanup![0].revision
  expect(newOwnerRevision).not.toBe(oldOwnerRevision)
  expect(newJobRevision).not.toBe(oldJobRevision)
  releaseResponse()
  await syncing
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.imageCleanup![0].revision).toBe(newJobRevision)
  expect(root.imageOwners![cleanupImageUrl]).toMatchObject({ revision: newOwnerRevision, hash: 'new-upload-hash' })
  // Cancel the local RPC's scheduled sync while the new task remains in its grace period.
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/file/delete/cleanup-hash'])
})

test('图片清理：移图时没有 Key，后来其他 Key 的空历史不能确认原账号或清除任务', async () => {
  const noKey = apply(imageCleanupDocument(), { type: 'edit', id: 'profile', patch: { seeApiKey: '' } })
  const { doc, etag } = await save(noKey, ['note-0'])
  const root = localWorkspace(doc, etag)
  const calls = mockImageCleanupService({ historyAbsent: () => true })
  await handle({ type: 'action', sourceId: 'source', action: { type: 'delete', id: 'note-0' } })
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.imageCleanup![0].credential).toBe('')
  await handle({ type: 'action', sourceId: 'source', action: { type: 'edit', id: 'profile', patch: { seeApiKey: 'cleanup-test-key' } } })
  expireImageCleanup(root)
  await synchronize('source')
  expect(calls).toEqual(['/api/v1/files?page=1'])
  expect(root.imageCleanup).toHaveLength(1)
  expect(root.imageCleanup![0].credential).toBe('')
  expect(root.sources.source.status).toBe('error')
  expect(root.sources.source.error).toContain('无法确认待删除图片的原账号')
})

test('没有变化且无笔记时只列目录一次、下载当前 JSON 一次', async () => {
  const { etag } = await save()
  const fid = current().fid
  clearCounts()
  await unchanged(etag)
  expect(listings).toEqual(['root'])
  expect([...downloads]).toEqual([[fid, 1]])
  expect(current().fid).toBe(fid)
})

test('20 篇未变化笔记不增加目录请求，不下载笔记正文', async () => {
  const { etag } = await save(withNotes(20), Array.from({ length: 20 }, (_, i) => 'note-' + i))
  const fid = current().fid
  clearCounts()
  await unchanged(etag)
  expect(listings).toEqual(['root'])
  expect([...downloads]).toEqual([[fid, 1]])
  expect(current().fid).toBe(fid)
  expect(listings.length + 2 * [...downloads.values()].reduce((sum, count) => sum + count, 0)).toBe(3)
})

test('合并仅改变对象键顺序时不重新上传当前 JSON', async () => {
  const { etag } = await save(withNotes(3))
  const fid = current().fid
  clearCounts()
  const store = new QuarkStore(config, etag)
  const remote = await store.read()
  const doc = { ...remote.doc!, entities: Object.fromEntries(Object.entries(remote.doc!.entities).reverse()) }
  await store.settle(doc, remote.etag!)
  expect(current().fid).toBe(fid)
  expect(listings).toEqual(['root'])
  expect([...downloads]).toEqual([[fid, 1]])
})

test('连续保存不创建同步历史或积累 JSON 与临时文件', async () => {
  let { doc, etag } = await save()
  for (let index = 0; index < 12; index++) {
    const store = new QuarkStore(config, etag)
    await store.read()
    doc = apply(doc, { type: 'edit', id: 'profile', patch: { title: '更新' + index } })
    etag = await store.write(doc, etag)
  }
  expect([...files.values()].map(file => file.name)).toEqual(['收藏.json'])
  expect(JSON.parse(current().body).entities.profile.title).toBe('更新11')
})

test('有效当前文件存在时不读取历史，成功同步后移除旧历史', async () => {
  const { etag } = await save()
  files.set('history', { fid: 'history', parentFid: 'root', name: '同步历史', isDirectory: true, size: 0, body: '' })
  files.set('old', { fid: 'old', parentFid: 'history', name: 'pg2-' + 'a'.repeat(32) + '.json', isDirectory: false, size: 1, body: '{broken' })
  clearCounts()
  await unchanged(etag)
  expect(downloads.has('old')).toBe(false)
  expect(listings).not.toContain('history')
  expect(files.has('history')).toBe(false)
  expect(files.has('old')).toBe(false)
})

test('另一设备已经写入时拒绝过期写入，保留当前云端数据', async () => {
  const { doc, etag } = await save()
  const first = new QuarkStore(config, etag), second = new QuarkStore(config, etag)
  await first.read(); await second.read()
  const changed = apply(doc, { type: 'edit', id: 'profile', patch: { title: '另一设备' } })
  await second.write(changed, etag)
  const fid = current().fid
  await expect(first.write(doc, etag)).rejects.toBeInstanceOf(RevisionChanged)
  expect(current().fid).toBe(fid)
  expect(current().body).toContain('另一设备')
})

test('上传期间另一设备更新时，提交前复查并拒绝覆盖', async () => {
  const { doc, etag } = await save()
  const store = new QuarkStore(config, etag)
  await store.read()
  const upload = QuarkClient.prototype.uploadSmallFile
  QuarkClient.prototype.uploadSmallFile = async options => {
    const result = await upload(options)
    const previous = current()
    files.delete(previous.fid)
    files.set('other', { ...previous, fid: 'other', body: previous.body.replace('Rain', 'Else') })
    return result
  }
  const changed = apply(doc, { type: 'edit', id: 'profile', patch: { title: '本机修改' } })
  await expect(store.write(changed, etag)).rejects.toBeInstanceOf(RevisionChanged)
  expect(current().fid).toBe('other')
})

test('当前文件损坏时不修改云端，历史也不清理', async () => {
  await save()
  current().body = '{broken'
  files.set('history', { fid: 'history', parentFid: 'root', name: '同步历史', isDirectory: true, size: 0, body: '' })
  const before = structuredClone([...files])
  await expect(new QuarkStore(config).read()).rejects.toThrow('已损坏')
  expect([...files]).toEqual(before)
})

test('上传内容校验失败时保留旧当前文件', async () => {
  const { doc, etag } = await save()
  const old = current(), store = new QuarkStore(config, etag)
  await store.read()
  QuarkClient.prototype.downloadFileText = async () => 'corrupt'
  await expect(store.write(apply(doc, { type: 'edit', id: 'profile', patch: { title: '新版' } }), etag)).rejects.toThrow('校验失败')
  expect(current()).toEqual(old)
})

test('发布新文件重命名失败时恢复旧文件，重试能收敛', async () => {
  const { doc, etag } = await save()
  const old = current(), store = new QuarkStore(config, etag)
  await store.read()
  const rename = QuarkClient.prototype.renameFile
  QuarkClient.prototype.renameFile = async (fid, name) => {
    if (fid !== old.fid && name === '收藏.json') throw new Error('rename failed')
    await rename(fid, name)
  }
  const changed = apply(doc, { type: 'edit', id: 'profile', patch: { title: '新版' } })
  await expect(store.write(changed, etag)).rejects.toThrow('rename failed')
  expect(current().fid).toBe(old.fid)
  QuarkClient.prototype.renameFile = rename
  await store.write(changed, etag)
  expect([...files.values()].map(file => file.name)).toEqual(['收藏.json'])
  expect(current().body).toContain('新版')
})

test('旧文件清理失败后重新同步能清理临时副本', async () => {
  const { doc, etag } = await save()
  const store = new QuarkStore(config, etag)
  await store.read()
  const remove = QuarkClient.prototype.deleteFile
  QuarkClient.prototype.deleteFile = async () => { throw new Error('delete failed') }
  await expect(store.write(apply(doc, { type: 'edit', id: 'profile', patch: { title: '新版' } }), etag)).rejects.toThrow('delete failed')
  expect(current().body).toContain('新版')
  QuarkClient.prototype.deleteFile = remove
  const retry = new QuarkStore(config)
  const remote = await retry.read()
  await retry.settle(remote.doc!, remote.etag!)
  expect([...files.values()].map(file => file.name)).toEqual(['收藏.json'])
})

test('普通同步不扫描或修复 Markdown，指定笔记操作才修复对应文件且不下载正文', async () => {
  const { etag } = await save(withNotes(3), ['note-0', 'note-1', 'note-2'])
  const notes = [...files.values()].filter(file => file.name.endsWith('.md'))
  files.delete(notes[0].fid)
  notes[1].body = '外部改动'; notes[1].updatedAt = 'changed'
  clearCounts()
  await unchanged(etag)
  expect(listings).toEqual(['root'])
  expect(files.has(notes[0].fid)).toBe(false)
  expect(notes[1].body).toBe('外部改动')
  const store = new QuarkStore(config, etag, ['note-0', 'note-1'])
  const remote = await store.read()
  await store.settle(remote.doc!, remote.etag!)
  expect(markdownDownloads).toEqual([])
  expect(files.get(notes[2].fid)).toEqual(notes[2])
  const bodies = [...files.values()].filter(file => file.name.endsWith('.md')).map(file => file.body).sort()
  expect(bodies).toEqual(['正文0', '正文1', '正文2'])
})

test('普通数据同步包含完整笔记正文但不创建 Markdown；新建笔记操作只发布指定笔记', async () => {
  const { etag } = await save(withNotes(2))
  expect([...files.values()].map(file => file.name)).toEqual(['收藏.json'])
  expect(JSON.parse(current().body).entities['note-1'].body).toBe('正文1')
  clearCounts()
  const store = new QuarkStore(config, etag, ['note-0'])
  const remote = await store.read()
  await store.settle(remote.doc!, remote.etag!)
  expect([...files.values()].filter(file => file.name.endsWith('.md')).map(file => file.body)).toEqual(['正文0'])
  expect(markdownDownloads).toEqual([])
})

test('更新已有笔记只列一次笔记目录，合并重复检查后总共五次 sort', async () => {
  const { doc, etag } = await save(withNotes(2), ['note-0', 'note-1'])
  const notesFolder = [...files.values()].find(file => file.name === '笔记')!.fid
  clearCounts()
  const store = new QuarkStore(config, etag, ['note-0'])
  await store.read()
  await store.write(apply(doc, { type: 'edit', id: 'note-0', patch: { body: '更新正文' } }), etag)
  expect(listings).toEqual(['root', 'root', notesFolder, 'root', 'root'])
  expect(markdownDownloads).toEqual([])
})

test('编辑发布失败后保留旧 Markdown，重试重新上传遗留临时文件且不下载正文', async () => {
  const { doc, etag } = await save(withNotes(2), ['note-0', 'note-1'])
  const old = [...files.values()].find(file => file.body === '正文0')!
  const untouched = [...files.values()].find(file => file.body === '正文1')!
  const changed = apply(doc, { type: 'edit', id: 'note-0', patch: { body: '新正文' } })
  const store = new QuarkStore(config, etag, ['note-0'])
  await store.read()
  clearCounts()
  const rename = QuarkClient.prototype.renameFile
  QuarkClient.prototype.renameFile = async (fid, name) => {
    if (fid !== old.fid && name.endsWith('.md')) throw new Error('rename failed')
    await rename(fid, name)
  }
  await expect(store.write(changed, etag)).rejects.toThrow('rename failed')
  expect(files.get(old.fid)?.name).toMatch(/.md$/)
  const pending = [...files.values()].find(file => file.name.startsWith('.拾页上传-') && file.parentFid === old.parentFid)!
  pending.body = '损坏的临时副本'
  QuarkClient.prototype.renameFile = rename
  await store.write(changed, etag)
  expect(files.has(pending.fid)).toBe(false)
  expect(files.get(untouched.fid)).toEqual(untouched)
  expect([...files.values()].filter(file => file.name.endsWith('.md')).map(file => file.body).sort()).toEqual(['新正文', '正文1'])
  expect(markdownDownloads).toEqual([])
  expect(downloads.has(old.fid)).toBe(false)
  expect(downloads.has(pending.fid)).toBe(false)
  expect([...files.values()].some(file => file.name.startsWith('.拾页'))).toBe(false)
})

test('首次 Markdown 发布失败后更名或删除，重试不遗留无回执的临时文件', async () => {
  const { doc, etag } = await save(withNotes(2))
  const rename = QuarkClient.prototype.renameFile
  QuarkClient.prototype.renameFile = async () => { throw new Error('rename failed') }
  const first = new QuarkStore(config, etag, ['note-0'])
  await first.read()
  await expect(first.write(doc, etag)).rejects.toThrow('rename failed')
  const second = new QuarkStore(config, etag, ['note-1'])
  await second.read()
  await expect(second.write(doc, etag)).rejects.toThrow('rename failed')
  QuarkClient.prototype.renameFile = rename
  const changed = apply(apply(doc, { type: 'edit', id: 'note-0', patch: { title: '重命名' } }), { type: 'delete', id: 'note-1' })
  const retry = new QuarkStore(config, etag, ['note-0', 'note-1'])
  await retry.read()
  await retry.write(changed, etag)
  expect([...files.values()].filter(file => file.name.endsWith('.md')).map(file => file.body)).toEqual(['正文0'])
  expect([...files.values()].some(file => file.name.startsWith('.拾页'))).toBe(false)
  expect(markdownDownloads).toEqual([])
})

test('同步中编辑页再次保存时，后续正文保留在队列并在下一次补传', async () => {
  const { doc, etag } = await save(withNotes(1), ['note-0'])
  const root = localWorkspace(doc, etag)
  await handle({ type: 'note-editor', sourceId: 'source', id: 'note-0', token: 'editor' }, 1)
  await handle({ type: 'save-note', sourceId: 'source', id: 'note-0', token: 'editor', title: '笔记0', body: '本轮正文' }, 1)
  const upload = QuarkClient.prototype.uploadSmallFile
  let edited = false
  QuarkClient.prototype.uploadSmallFile = async options => {
    if (!edited && options.mimeType.startsWith('text/markdown')) {
      edited = true
      await handle({ type: 'save-note', sourceId: 'source', id: 'note-0', token: 'editor', title: '笔记0', body: '后续正文' }, 1)
    }
    return upload(options)
  }
  await synchronize('source')
  expect(edited).toBe(true)
  expect(root.sources.source.pendingNoteIds).toEqual(['note-0'])
  await synchronize('source')
  expect({ status: root.sources.source.status, error: root.sources.source.error, conflicts: root.sources.source.conflicts }).toEqual({ status: 'synced', error: '', conflicts: [] })
  expect(root.sources.source.pendingNoteIds).toEqual([])
  expect([...files.values()].find(file => file.name.endsWith('.md'))?.body).toBe('后续正文')
  expect(root.sources.source.status).toBe('synced')
  expect(markdownDownloads).toEqual([])
})

test('导入备份只为新加入的笔记补建 Markdown', async () => {
  const { doc, etag } = await save()
  const root = localWorkspace(doc, etag)
  await handle({ type: 'import', sourceId: 'source', data: withNotes(1, doc), confirmed: true })
  expect(root.sources.source.pendingNoteIds).toEqual(['note-0'])
  for (const conflict of [...root.sources.source.conflicts]) await handle({ type: 'resolve', sourceId: 'source', conflictId: conflict.id, side: 'local' })
  await synchronize('source')
  expect({ status: root.sources.source.status, error: root.sources.source.error, conflicts: root.sources.source.conflicts }).toEqual({ status: 'synced', error: '', conflicts: [] })
  expect(root.sources.source.pendingNoteIds).toEqual([])
  expect([...files.values()].filter(file => file.name.endsWith('.md')).map(file => file.body)).toEqual(['正文0'])
})

test('迁移到空夸克账号时保留原有笔记并创建独立 Markdown', async () => {
  localWorkspace(withNotes(1), null)
  stored['new-page.quark.auth.v1'] = { accounts: { root: 'synthetic-cookie' } }
  const result = await handle({ type: 'connect', config: { ...config, accountId: 'root' }, nickname: 'Rain', mode: 'migrate', confirmed: true })
  expect(result.ok).toBe(true)
  await synchronize('quark:root')
  expect([...files.values()].filter(file => file.name.endsWith('.md')).map(file => file.body)).toEqual(['正文0'])
  expect(JSON.parse(current().body).entities['note-0'].body).toBe('正文0')
})

test('已建立连接的当前文件消失时不当成空账号覆盖', async () => {
  const { etag } = await save()
  files.clear()
  await expect(new QuarkStore(config, etag).read()).rejects.toThrow('已被移除')
})

test('旧历史清理失败保留当前数据，下次同步重试', async () => {
  const { etag } = await save()
  files.set('history', { fid: 'history', parentFid: 'root', name: '同步历史', isDirectory: true, size: 0, body: '' })
  const remove = QuarkClient.prototype.deleteFile
  QuarkClient.prototype.deleteFile = async () => { throw new Error('delete failed') }
  await expect(unchanged(etag)).rejects.toThrow('delete failed')
  expect(files.has('history')).toBe(true)
  expect(current().name).toBe('收藏.json')
  QuarkClient.prototype.deleteFile = remove
  await unchanged(etag)
  expect(files.has('history')).toBe(false)
})

test('更名过程中后台退出后，新实例恢复已校验的旧当前文件', async () => {
  const { etag } = await save()
  const previous = current()
  const target = createHash('sha256').update('收藏.json').digest('hex').slice(0, 32)
  previous.name = '.拾页旧版-' + target + '-' + previous.fid
  const restarted = new QuarkStore(config, etag)
  const remote = await restarted.read()
  expect(remote.doc?.entities.profile.title).toBe('Rain')
  expect(current().fid).toBe(previous.fid)
  await restarted.settle(remote.doc!, remote.etag!)
  expect([...files.values()].map(file => file.name)).toEqual(['收藏.json'])
})

test('首次发布中断后可恢复完整临时 JSON，损坏临时文件不会发布', async () => {
  await save()
  const previous = current()
  const target = createHash('sha256').update('收藏.json').digest('hex').slice(0, 32)
  const content = createHash('sha256').update(previous.body).digest('hex').slice(0, 32)
  previous.name = '.拾页上传-' + target + '-' + content
  const restarted = new QuarkStore(config)
  expect((await restarted.read()).doc?.entities.profile.title).toBe('Rain')
  previous.name = '.拾页上传-' + target + '-' + content
  previous.body = '{broken'
  await expect(new QuarkStore(config).read()).rejects.toThrow()
  expect([...files.values()].some(file => file.name === '收藏.json')).toBe(false)
})

test('已确认新版本后遇到旧的有效目录结果时拒绝回退', async () => {
  const { doc, etag } = await save()
  const old = structuredClone(current())
  const store = new QuarkStore(config, etag)
  await store.read()
  const changed = apply(doc, { type: 'edit', id: 'profile', patch: { title: '已确认新版' } })
  const next = await store.write(changed, etag)
  files.delete(current().fid)
  files.set(old.fid, old)
  await expect(new QuarkStore(config, next).read()).rejects.toThrow('尚未')
})
