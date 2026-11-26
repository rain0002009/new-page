import { describe, expect, test } from 'vitest'
import {
  active,
  apply,
  createDocument,
  filterTagSelection,
  tagUsages,
  readDocument,
  type Collection,
  type Document,
  type Link,
  type Note,
  type Tag,
} from '../../src/core/model'
import { emptyDocument, merge } from '../../src/core/merge'

function fixture() {
  const doc = createDocument('Rain')
  const space = active(doc).find(e => e.kind === 'space')!
  const collection = active(doc).find(e => e.kind === 'collection') as Collection
  const withLink = apply(doc, {
    type: 'add-links',
    parentId: collection.id,
    links: [{ title: '示例链接', url: 'https://example.com', note: '备注' }],
  })
  const link = active(withLink).find(e => e.kind === 'link') as Link
  return { doc: withLink, space, collection, link }
}

function tag(doc: Document, id: string): Tag {
  const value = doc.entities[id]
  if (value?.kind !== 'tag') throw new Error('missing tag')
  return value
}

describe('Tag catalog', () => {
  test('creates reusable tags and assigns ordered tag IDs to collections, links and notes', () => {
    const { doc, collection, link } = fixture()
    const noteId = 'note-1'
    let next = apply(doc, { type: 'add-note', parentId: collection.id, id: noteId })
    next = apply(next, { type: 'add-tag', id: 'tag-blue', name: '工作', color: 'blue' })
    next = apply(next, { type: 'add-tag', id: 'tag-red', name: '工作', color: 'red' })
    next = apply(next, { type: 'set-tags', id: collection.id, tagIds: ['tag-blue', 'tag-red'] })
    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-red'] })
    next = apply(next, { type: 'set-tags', id: noteId, tagIds: ['tag-blue'] })

    expect(tag(next, 'tag-blue').title).toBe('工作')
    expect((next.entities[collection.id] as Collection).tagIds).toEqual(['tag-blue', 'tag-red'])
    expect((next.entities[link.id] as Link).tagIds).toEqual(['tag-red'])
    expect((next.entities[noteId] as Note).tagIds).toEqual(['tag-blue'])
  })

  test('uses name and color as identity and enforces the 20-character name limit', () => {
    let next = fixture().doc
    next = apply(next, { type: 'add-tag', id: 'dup', name: '工作', color: 'blue' })
    expect(() => apply(next, { type: 'add-tag', id: 'dup-2', name: '工作', color: 'blue' })).toThrow('标签已存在')
    expect(() => apply(next, { type: 'add-tag', id: 'same-name-red', name: '工作', color: 'red' })).not.toThrow()
    expect(() => apply(next, { type: 'add-tag', id: 'long', name: '超'.repeat(21), color: 'blue' })).toThrow('标签名称最多 20 个字符')
  })
  test('edits a shared tag in place and merges it into an existing name/color identity', () => {
    const { doc, collection, link } = fixture()
    let next = apply(doc, { type: 'add-tag', id: 'tag-a', name: '旧名称', color: 'blue' })
    next = apply(next, { type: 'add-tag', id: 'tag-b', name: '新名称', color: 'green' })
    next = apply(next, { type: 'set-tags', id: collection.id, tagIds: ['tag-a'] })
    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-b'] })

    next = apply(next, { type: 'edit-tag', id: 'tag-a', name: '新名称', color: 'green' })

    expect(tag(next, 'tag-a').title).toBe('新名称')
    expect(next.entities['tag-b']).toBeUndefined()
    expect((next.entities[collection.id] as Collection).tagIds).toEqual(['tag-a'])
    expect((next.entities[link.id] as Link).tagIds).toEqual(['tag-a'])
  })

  test('deletes a tag permanently, removes every reference and keeps it out of the recycle bin', () => {
    const { doc, collection, link } = fixture()
    let next = apply(doc, { type: 'add-tag', id: 'tag-delete', name: '临时', color: 'purple' })
    next = apply(next, { type: 'set-tags', id: collection.id, tagIds: ['tag-delete'] })
    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-delete'] })

    const deleted = apply(next, { type: 'delete-tag', id: 'tag-delete' })
    const record = deleted.entities['tag-delete']
    expect(record.purged).toBe(true)
    expect((deleted.entities[collection.id] as Collection).tagIds ?? []).toEqual([])
    expect((deleted.entities[link.id] as Link).tagIds ?? []).toEqual([])
    expect(active(deleted).some(e => e.id === 'tag-delete')).toBe(false)
    expect(Object.values(deleted.entities).filter(e => e.kind === 'tag' && e.deletedAt !== null && !e.purged)).toEqual([])
  })

  test('generic delete and purge cannot put tags into the recycle bin', () => {
    let next = apply(fixture().doc, { type: 'add-tag', id: 'tag-guard', name: '保护', color: 'orange' })
    expect(() => apply(next, { type: 'delete', id: 'tag-guard' })).toThrow('标签只能永久删除')
    expect(() => apply(next, { type: 'purge', id: 'tag-guard' })).toThrow('标签只能永久删除')
  })

  test('counts non-BMP tag names as user-visible characters', () => {
    const { doc } = fixture()
    expect(() => apply(doc, { type: 'add-tag', id: 'emoji-ok', name: '😀'.repeat(20), color: 'green' })).not.toThrow()
    expect(() => apply(doc, { type: 'add-tag', id: 'emoji-long', name: '😀'.repeat(21), color: 'green' })).toThrow('标签名称最多 20 个字符')
  })

  test('reading a document trims tag names and drops references to deleted tags', () => {
    let next = apply(fixture().doc, { type: 'add-tag', id: 'tag-stale', name: '  失效  ', color: 'cyan' })
    next = apply(next, { type: 'set-tags', id: active(next).find(e => e.kind === 'link')!.id, tagIds: ['tag-stale'] })
    next = apply(next, { type: 'delete-tag', id: 'tag-stale' })
    const link = active(next).find(e => e.kind === 'link') as Link
    expect(link.tagIds ?? []).toEqual([])
  })

  test('legacy documents without tag fields still parse', () => {
    const legacy = {
      format: 'new-page',
      version: 1,
      entities: {
        profile: { id: 'profile', kind: 'profile', title: 'Rain', parentId: null, position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false },
        space: { id: 'space', kind: 'space', title: '我的空间', parentId: null, position: 1, updatedAt: 1, deletedAt: null, deletedBy: null, purged: false },
      },
    }
    expect(() => readDocument(legacy)).not.toThrow()
  })
})

describe('Tag usage management', () => {
  test('derives direct tag usages without expanding tagged collection children', () => {
    const { doc, collection, link } = fixture()
    const noteId = 'note-usage'
    let next = apply(doc, { type: 'add-note', parentId: collection.id, id: noteId })
    next = apply(next, { type: 'add-tag', id: 'tag-usage', name: '用途', color: 'blue' })
    next = apply(next, { type: 'set-tags', id: collection.id, tagIds: ['tag-usage'] })
    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-usage'] })
    next = apply(next, { type: 'set-tags', id: noteId, tagIds: ['tag-usage'] })

    const usages = tagUsages(next, 'tag-usage')
    expect(usages.map(usage => usage.entityId)).toEqual([collection.id, link.id, noteId])
    expect(usages[0].path).toEqual(['我的空间', '日常收藏'])
    expect(usages[1].path).toEqual(['我的空间', '日常收藏', '示例链接'])
    expect(usages[2].path).toEqual(['我的空间', '日常收藏', '新笔记'])
  })

  test('unbinding one direct usage preserves other tags and the tag catalog', () => {
    const { doc, link } = fixture()
    let next = apply(doc, { type: 'add-tag', id: 'tag-a', name: 'A', color: 'blue' })
    next = apply(next, { type: 'add-tag', id: 'tag-b', name: 'B', color: 'red' })
    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-a', 'tag-b'] })

    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-b'] })

    expect((next.entities[link.id] as Link).tagIds).toEqual(['tag-b'])
    expect(next.entities['tag-a']).toBeDefined()
    expect(tagUsages(next, 'tag-a')).toEqual([])
    expect(tagUsages(next, 'tag-b').map(usage => usage.entityId)).toEqual([link.id])
  })
})

describe('Tag filtering and merge semantics', () => {
  test('collection tag matches expand all cards while card matches keep only matching cards', () => {
    const { doc, collection, link } = fixture()
    const noteId = 'note-filter'
    let next = apply(doc, { type: 'add-note', parentId: collection.id, id: noteId })
    next = apply(next, { type: 'add-tag', id: 'tag-hit', name: '命中', color: 'blue' })
    next = apply(next, { type: 'add-tag', id: 'tag-card', name: '卡片', color: 'red' })
    next = apply(next, { type: 'set-tags', id: link.id, tagIds: ['tag-hit'] })
    next = apply(next, { type: 'set-tags', id: noteId, tagIds: ['tag-card'] })
    next = apply(next, { type: 'set-tags', id: collection.id, tagIds: ['tag-card'] })

    const byCard = filterTagSelection(next, active(next).find(e => e.kind === 'space')!.id, ['tag-hit'])
    expect(byCard.get(collection.id)?.map(item => item.id)).toEqual([link.id])

    const byCollection = filterTagSelection(next, active(next).find(e => e.kind === 'space')!.id, ['tag-card'])
    expect(byCollection.get(collection.id)?.map(item => item.id).sort()).toEqual([link.id, noteId].sort())
  })

  test('merges concurrent same identity tags and unions concurrent assignment additions', () => {
    const { doc, collection, link } = fixture()
    const base = doc
    const local = apply(base, { type: 'add-tag', id: 'local-tag', name: '同步', color: 'cyan' })
    const remote = apply(base, { type: 'add-tag', id: 'remote-tag', name: '同步', color: 'cyan' })
    const localWithRefs = apply(local, { type: 'set-tags', id: collection.id, tagIds: ['local-tag'] })
    const remoteWithRefs = apply(remote, { type: 'set-tags', id: link.id, tagIds: ['remote-tag'] })
    const result = merge(base, localWithRefs, remoteWithRefs)

    const tags = Object.values(result.doc.entities).filter((e): e is Tag => e.kind === 'tag' && !e.purged)
    expect(tags).toHaveLength(1)
    const canonical = tags[0].id
    expect((result.doc.entities[collection.id] as Collection).tagIds).toEqual([canonical])
    expect((result.doc.entities[link.id] as Link).tagIds).toEqual([canonical])
  })

  test('concurrent creation of the same identity loses to a different-ID deletion', () => {
    const { doc, link } = fixture()
    const base = doc
    const localDeleted = apply(apply(base, { type: 'add-tag', id: 'deleted-tag', name: '竞争', color: 'purple' }), { type: 'delete-tag', id: 'deleted-tag' })
    const remoteCreated = apply(base, { type: 'add-tag', id: 'created-tag', name: '竞争', color: 'purple' })
    const withRefs = apply(remoteCreated, { type: 'set-tags', id: link.id, tagIds: ['created-tag'] })
    const result = merge(base, localDeleted, withRefs)
    const activeTags = Object.values(result.doc.entities).filter((e): e is Tag => e.kind === 'tag' && !e.purged)
    expect(activeTags).toEqual([])
    expect((result.doc.entities[link.id] as Link).tagIds ?? []).toEqual([])
  })

  test('tag deletion wins over a concurrent edit and keeps the hidden sync tombstone', () => {
    const { doc, link } = fixture()
    const base = apply(doc, { type: 'add-tag', id: 'tag-race', name: '竞争', color: 'yellow' })
    const withRef = apply(base, { type: 'set-tags', id: link.id, tagIds: ['tag-race'] })
    const local = apply(withRef, { type: 'delete-tag', id: 'tag-race' })
    const remote = apply(withRef, { type: 'edit-tag', id: 'tag-race', name: '已改名', color: 'green' })
    const result = merge(withRef, local, remote)

    const record = result.doc.entities['tag-race']
    expect(record.purged).toBe(true)
    expect((result.doc.entities[link.id] as Link).tagIds ?? []).toEqual([])
    expect(result.conflicts.filter(c => c.entityId === 'tag-race')).toEqual([])
  })
})
