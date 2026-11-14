import { test, expect } from '@playwright/test'
import { createHash } from 'node:crypto'
import { apply, createDocument, type Document, type Note } from '../src/core/model'
import type { StoredWorkspace, WorkspaceSource } from '../src/core/local-workspace'
import { imageCredential, imageIsReferenced, queueDocumentImageChanges, queueRemovedImages, sourceImageKey, updateLocalImageDocument } from '../src/core/hosted-images'

const url = 'https://images.example.test/upload.png'
const image = `![图片](${url})`
const key = 'test-image-cleanup-secret'

function documentWithNote(body = image, apiKey = key): Document {
  let doc = createDocument('图片清理测试')
  const collection = Object.values(doc.entities).find(entity => entity.kind === 'collection')!
  doc = apply(doc, { type: 'edit', id: 'profile', patch: { seeApiKey: apiKey } })
  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: 'test-note' })
  return apply(doc, { type: 'edit', id: 'test-note', patch: { body } })
}

function source(doc: Document): WorkspaceSource {
  return { config: { kind: 'quark', accountId: 'test', folderId: 'test', nickname: '测试' }, doc, base: structuredClone(doc), etag: null, conflicts: [], status: 'pending', error: '', lastSync: null }
}

function workspace(doc = documentWithNote()): StoredWorkspace {
  return { active: 'first', sources: { first: source(doc) } }
}

function note(doc: Document): Note {
  const value = doc.entities['test-note']
  if (value.kind !== 'note') throw new Error('测试缺少笔记')
  return value
}

test('单篇笔记永久删除后登记原图任务，清空正文后不再保护引用', () => {
  const root = workspace()
  const before = root.sources.first.doc
  const after = apply(before, { type: 'delete', id: 'test-note' })
  root.sources.first.doc = after
  queueDocumentImageChanges(root, 'first', before, after)
  expect(note(after).purged).toBe(true)
  expect(root.imageCleanup).toEqual([expect.objectContaining({ sourceId: 'first', url })])
  expect(imageIsReferenced(root, url)).toBe(false)
})

test('正文移除图床图片时登记清理任务，修改标题不触发清理', () => {
  const root = workspace()
  const before = root.sources.first.doc
  const renamed = apply(before, { type: 'edit', id: 'test-note', patch: { title: '新标题' } })
  queueDocumentImageChanges(root, 'first', before, renamed)
  expect(root.imageCleanup ?? []).toEqual([])
  const after = apply(renamed, { type: 'edit', id: 'test-note', patch: { body: '图片已移除' } })
  root.sources.first.doc = after
  queueDocumentImageChanges(root, 'first', renamed, after)
  expect(root.imageCleanup?.map(job => job.url)).toEqual([url])
  expect(imageIsReferenced(root, url)).toBe(false)
})

test('正文中的重复图片或其他笔记仍引用同一地址时保留原图', () => {
  const before = documentWithNote(`${image}\n\n![同图](${url}#second)`)
  const root = workspace(before)
  const after = apply(before, { type: 'edit', id: 'test-note', patch: { body: `![保留](${url}#remaining)` } })
  queueDocumentImageChanges(root, 'first', before, after)
  expect(root.imageCleanup ?? []).toEqual([])
  let shared = apply(after, { type: 'add-note', parentId: note(after).parentId!, id: 'shared-note' })
  shared = apply(shared, { type: 'edit', id: 'shared-note', patch: { body: image } })
  const removed = apply(shared, { type: 'delete', id: 'test-note' })
  root.sources.first.doc = removed
  queueDocumentImageChanges(root, 'first', shared, removed)
  expect(root.imageCleanup).toHaveLength(1)
  expect(imageIsReferenced(root, url)).toBe(true)
})

test('收藏块进入回收站时保护图片，永久清空后才登记清理', () => {
  const root = workspace()
  const before = root.sources.first.doc
  const trashed = apply(before, { type: 'delete', id: note(before).parentId! })
  root.sources.first.doc = trashed
  queueDocumentImageChanges(root, 'first', before, trashed)
  expect(root.imageCleanup ?? []).toEqual([])
  expect(imageIsReferenced(root, url)).toBe(true)
  const purged = apply(trashed, { type: 'empty-trash' })
  root.sources.first.doc = purged
  queueDocumentImageChanges(root, 'first', trashed, purged)
  expect(root.imageCleanup?.map(job => job.url)).toEqual([url])
  expect(imageIsReferenced(root, url)).toBe(false)
})

test('其他数据源和未解决冲突的双方版本均可保护图片', () => {
  const root = workspace(documentWithNote('无图片'))
  root.sources.second = source(documentWithNote())
  expect(imageIsReferenced(root, url)).toBe(true)
  delete root.sources.second
  const version = note(documentWithNote())
  const absent = note(documentWithNote('没有图片'))
  root.sources.first.conflicts = [{ id: 'conflict', entityId: version.id, fields: ['body'], local: version, remote: absent, localParents: [], remoteParents: [] }]
  expect(imageIsReferenced(root, url)).toBe(true)
  root.sources.first.conflicts[0].local = absent
  root.sources.first.conflicts[0].remote = version
  expect(imageIsReferenced(root, url)).toBe(true)
  root.sources.first.conflicts = []
  expect(imageIsReferenced(root, url)).toBe(false)
})

test('本地 Markdown 引用保护图片，保存移除后的正文会登记清理', () => {
  const root = workspace(documentWithNote('无图片'))
  updateLocalImageDocument(root, 'local-file', `${image}\n\n![重复](${url}#same)`)
  expect(root.imageDocuments?.['local-file'].urls).toEqual([url])
  expect(root.imageCleanup ?? []).toEqual([])
  expect(imageIsReferenced(root, url)).toBe(true)
  updateLocalImageDocument(root, 'local-file', '图片已移除', image)
  expect(root.imageCleanup?.map(job => job.url)).toEqual([url])
  expect(imageIsReferenced(root, url)).toBe(false)
})

test('重复任务合并并从最近一次移除起预留 30 秒撤销时间', () => {
  const originalNow = Date.now
  let now = 100_000
  Date.now = () => now
  try {
    const root = workspace()
    queueRemovedImages(root, 'first', image, '')
    expect(root.imageCleanup).toHaveLength(1)
    expect(root.imageCleanup?.[0].notBefore).toBe(130_000)
    now += 5000
    queueRemovedImages(root, 'first', image, '')
    expect(root.imageCleanup).toHaveLength(1)
    expect(root.imageCleanup?.[0].notBefore).toBe(135_000)
    root.sources.first.doc = documentWithNote()
    expect(imageIsReferenced(root, url)).toBe(true)
  } finally { Date.now = originalNow }
})

test('任务凭据绑定使用去除空格后的 SHA-256 指纹，不另存密钥明文', () => {
  const root = workspace(documentWithNote(image, `  ${key}  `))
  expect(sourceImageKey(root, 'first')).toBe(key)
  const fingerprint = createHash('sha256').update(key).digest('hex')
  expect(imageCredential(`  ${key}  `)).toBe(fingerprint)
  queueRemovedImages(root, 'first', image, '')
  expect(root.imageCleanup?.[0].credential).toBe(fingerprint)
  expect(JSON.stringify(root.imageCleanup)).not.toContain(key)
  expect(sourceImageKey(root, 'missing')).toBe('')
})

test('没有 API Key 时仍持久登记待清理地址，恢复配置前不丢失任务', () => {
  const root = workspace(documentWithNote(image, ''))
  const before = root.sources.first.doc
  const after = apply(before, { type: 'delete', id: 'test-note' })
  root.sources.first.doc = after
  queueDocumentImageChanges(root, 'first', before, after)
  expect(sourceImageKey(root, 'first')).toBe('')
  expect(root.imageCleanup).toEqual([expect.objectContaining({ sourceId: 'first', url, credential: '' })])
  const restored = structuredClone(root)
  expect(restored.imageCleanup).toEqual(root.imageCleanup)
})
