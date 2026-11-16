import { test, expect } from '@playwright/test'
import { active, apply, createDocument, type Document, type ShareRecord } from '../src/core/model'

function createDocWithNote() {
  let doc = createDocument('Tester')
  const collection = active(doc).find(entity => entity.kind === 'collection')!
  const noteId = 'note-test-1'
  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: noteId })
  return { doc, noteId, collectionId: collection.id }
}

test('创建分享记录并检验相同笔记不可重复分享', () => {
  const { doc, noteId } = createDocWithNote()
  const shareId = 'share-test-1'
  const next = apply(doc, {
    type: 'add-share',
    id: shareId,
    entityKind: 'note',
    entityId: noteId,
    domain: 's.ee',
    slug: 'slug123',
    shortUrl: 'https://s.ee/slug123',
    title: '分享测试笔记',
    expireAt: 1775000000,
    hasPassword: false,
  })

  const share = next.entities[shareId] as ShareRecord
  expect(share).toBeDefined()
  expect(share.kind).toBe('share')
  expect(share.entityKind).toBe('note')
  expect(share.entityId).toBe(noteId)
  expect(share.domain).toBe('s.ee')
  expect(share.slug).toBe('slug123')
  expect(share.shortUrl).toBe('https://s.ee/slug123')
  expect(share.title).toBe('分享测试笔记')
  expect(share.expireAt).toBe(1775000000)
  expect(share.hasPassword).toBe(false)
  expect(share.purged).toBe(false)

  // 相同笔记不能重复分享
  expect(() => apply(next, {
    type: 'add-share',
    id: 'share-test-2',
    entityKind: 'note',
    entityId: noteId,
    domain: 's.ee',
    slug: 'slug456',
    shortUrl: 'https://s.ee/slug456',
    title: '重复分享',
  })).toThrow('此笔记已生成过分享，不能重复分享')
})

test('更新分享记录的标题与过期时间', () => {
  const { doc, noteId } = createDocWithNote()
  const shareId = 'share-test-1'
  let current = apply(doc, {
    type: 'add-share',
    id: shareId,
    entityKind: 'note',
    entityId: noteId,
    domain: 's.ee',
    slug: 'slug123',
    shortUrl: 'https://s.ee/slug123',
    title: '原标题',
    expireAt: null,
  })

  current = apply(current, {
    type: 'update-share',
    id: shareId,
    title: '新标题',
    expireAt: 1800000000,
  })

  const share = current.entities[shareId] as ShareRecord
  expect(share.title).toBe('新标题')
  expect(share.expireAt).toBe(1800000000)
})

test('删除分享记录直接永久删除绕过回收站，并允许重新分享该笔记', () => {
  const { doc, noteId } = createDocWithNote()
  const shareId = 'share-test-1'
  let current = apply(doc, {
    type: 'add-share',
    id: shareId,
    entityKind: 'note',
    entityId: noteId,
    domain: 's.ee',
    slug: 'slug123',
    shortUrl: 'https://s.ee/slug123',
    title: '分享测试',
  })

  const afterDelete = apply(current, { type: 'delete-share', id: shareId })
  const share = afterDelete.entities[shareId]
  expect(share.purged).toBe(true)
  expect(share.deletedAt).not.toBeNull()

  // 回收站不显示此记录
  const inRecycleBin = Object.values(afterDelete.entities).filter(
    e => !e.purged && e.deletedAt !== null && e.deletedBy === e.id
  )
  expect(inRecycleBin.some(e => e.id === shareId)).toBe(false)

  // 允许重新为该笔记创建分享
  const recreated = apply(afterDelete, {
    type: 'add-share',
    id: 'share-test-new',
    entityKind: 'note',
    entityId: noteId,
    domain: 'fs.to',
    slug: 'slug789',
    shortUrl: 'https://fs.to/slug789',
    title: '新分享',
  })
  expect(recreated.entities['share-test-new']).toBeDefined()
})

test('删除原笔记不级联删除分享记录（生命周期解耦）', () => {
  const { doc, noteId } = createDocWithNote()
  const shareId = 'share-test-1'
  let current = apply(doc, {
    type: 'add-share',
    id: shareId,
    entityKind: 'note',
    entityId: noteId,
    domain: 's.ee',
    slug: 'slug123',
    shortUrl: 'https://s.ee/slug123',
    title: '分享测试',
  })

  // 单独删除笔记
  current = apply(current, { type: 'delete', id: noteId })
  expect(current.entities[noteId].purged).toBe(true)

  // 分享记录依然存活
  const share = current.entities[shareId]
  expect(share).toBeDefined()
  expect(share.purged).toBe(false)
  expect(share.deletedAt).toBeNull()
})
