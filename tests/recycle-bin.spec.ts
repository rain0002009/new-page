import { test, expect } from '@playwright/test'
import { active, apply, createDocument, prune, type Document } from '../src/core/model'

function fixture() {
  let doc = createDocument('Rain')
  const collection = active(doc).find(entity => entity.kind === 'collection')!
  doc = apply(doc, { type: 'add-links', parentId: collection.id, links: [
    { title: '先删除的链接', url: 'https://example.com/first', note: '删除正文' },
    { title: '随收藏块删除的链接', url: 'https://example.com/second' },
  ] })
  const links = active(doc).filter(entity => entity.kind === 'link')
  doc = apply(doc, { type: 'todo', id: links[0].id, value: true })
  doc = apply(doc, { type: 'delete', id: links[0].id })
  doc = apply(doc, { type: 'delete', id: collection.id })
  return { doc, collection, links }
}

function expectPurged(doc: Document, ids: string[]) {
  for (const id of ids) {
    const entity = doc.entities[id]
    expect(entity.purged).toBe(true)
    expect(entity.title).toBe('')
    if (entity.kind === 'link') {
      expect([entity.url, entity.note, entity.icon]).toEqual(['', '', ''])
      expect(entity.todo).toBe(false)
    }
    expect(() => apply(doc, { type: 'restore', id })).toThrow('无法恢复')
  }
}

test('彻底删除父级同时清理先前单独删除的子项，保留同步删除标记', () => {
  const { doc, collection, links } = fixture()
  const purged = apply(doc, { type: 'purge', id: collection.id })
  expectPurged(purged, [collection.id, ...links.map(link => link.id)])
  expect(purged.entities[links[0].id].deletedAt).toBe(doc.entities[links[0].id].deletedAt)
  expect(purged.entities.profile).toEqual(doc.entities.profile)
  expect(doc.entities[collection.id].purged).toBe(false)
  expect(() => apply(doc, { type: 'purge', id: 'profile' })).toThrow('回收站内容已改变')
  expect(() => apply(doc, { type: 'purge', id: 'missing' })).toThrow('回收站内容已改变')
})

test('单项删除保留其他回收站内容，清空只处理已删除内容并可重复执行', () => {
  const { doc, collection, links } = fixture()
  const single = apply(doc, { type: 'purge', id: links[0].id })
  expectPurged(single, [links[0].id])
  expect(single.entities[collection.id]).toEqual(doc.entities[collection.id])
  expect(single.entities[links[1].id]).toEqual(doc.entities[links[1].id])
  const empty = apply(single, { type: 'empty-trash' })
  expectPurged(empty, [collection.id, ...links.map(link => link.id)])
  expect(active(empty)).toEqual(active(doc))
  expect(apply(empty, { type: 'empty-trash' })).toEqual(empty)
})

test('手动删除与三十天到期清理使用相同的正文清理规则', () => {
  const { doc, collection, links } = fixture()
  const now = Math.max(...Object.values(doc.entities).map(entity => entity.deletedAt ?? 0)) + 31 * 86400_000
  expectPurged(prune(doc, now), [collection.id, ...links.map(link => link.id)])
})
