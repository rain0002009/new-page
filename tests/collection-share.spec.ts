import { test, expect } from '@playwright/test'
import { active, apply, createDocument, type Document } from '../src/core/model'
import { collectionToMarkdown } from '../src/core/see'

function setupCollectionDoc() {
  let doc = createDocument('Tester')
  const collection = active(doc).find(entity => entity.kind === 'collection')!

  // Add 2 links: link1 with note, link2 without note
  doc = apply(doc, {
    type: 'add-links',
    parentId: collection.id,
    links: [
      { title: 'GitHub', url: 'https://github.com', note: '代码仓库托管与协作平台' },
      { title: 'TypeScript', url: 'https://www.typescriptlang.org' },
    ],
  })

  // Add 2 notes: note1 (shared), note2 (unshared)
  const note1Id = 'note-shared-1'
  const note2Id = 'note-unshared-2'
  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: note1Id })
  doc = apply(doc, {
    type: 'edit',
    id: note1Id,
    patch: { title: '架构备忘录', body: '# 架构设计\n\n核心架构采用独立快照同步。' },
  })

  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: note2Id })
  doc = apply(doc, {
    type: 'edit',
    id: note2Id,
    patch: { title: '草稿笔记', body: '未公开的私密笔记正文。' },
  })

  // Share note1
  doc = apply(doc, {
    type: 'add-share',
    id: 'share-note-1',
    entityKind: 'note',
    entityId: note1Id,
    domain: 's.ee',
    slug: 'arch-memo',
    shortUrl: 'https://s.ee/arch-memo',
    title: '架构备忘录公开分享',
  })

  return { doc, collectionId: collection.id, note1Id, note2Id }
}

test('collectionToMarkdown 在 includeNotes 为 false 时仅导出链接卡片', () => {
  const { doc, collectionId } = setupCollectionDoc()
  const collection = doc.entities[collectionId]
  const result = collectionToMarkdown(doc, collectionId, { includeNotes: false })

  expect(result.itemCount).toBe(2)
  expect(result.noteCount).toEqual({ shared: 1, unshared: 1 })
  expect(result.content).toContain(`# ${collection.title}`)
  expect(result.content).toContain('- [GitHub](https://github.com/)\n  > 代码仓库托管与协作平台')
  expect(result.content).toContain('- [TypeScript](https://www.typescriptlang.org/)')
  // 不包含任何笔记
  expect(result.content).not.toContain('架构备忘录')
  expect(result.content).not.toContain('https://s.ee/arch-memo')
  expect(result.content).not.toContain('草稿笔记')
})

test('collectionToMarkdown 在 includeNotes 为 true 时包含已分享笔记并忽略未分享笔记', () => {
  const { doc, collectionId } = setupCollectionDoc()
  const collection = doc.entities[collectionId]
  const result = collectionToMarkdown(doc, collectionId, { includeNotes: true })

  expect(result.itemCount).toBe(3) // 2 links + 1 shared note
  expect(result.noteCount).toEqual({ shared: 1, unshared: 1 })
  expect(result.content).toContain(`# ${collection.title}`)
  expect(result.content).toContain('- [GitHub](https://github.com/)\n  > 代码仓库托管与协作平台')
  expect(result.content).toContain('- [TypeScript](https://www.typescriptlang.org/)')
  // 包含已分享笔记（带短链与摘要）
  expect(result.content).toContain('- 📝 [架构备忘录](https://s.ee/arch-memo)\n  > 架构设计')
  // 未分享笔记被完全忽略
  expect(result.content).not.toContain('草稿笔记')
  expect(result.content).not.toContain('未公开的私密笔记')
})

test('collectionToMarkdown 针对空收藏块或只有未分享笔记时正确返回 itemCount = 0', () => {
  let doc = createDocument('Tester')
  const collection = active(doc).find(entity => entity.kind === 'collection')!
  const emptyResult = collectionToMarkdown(doc, collection.id, { includeNotes: true })
  expect(emptyResult.itemCount).toBe(0)
  expect(emptyResult.noteCount).toEqual({ shared: 0, unshared: 0 })

  // 添加一个未分享笔记
  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: 'only-unshared-note' })
  const withUnsharedOnly = collectionToMarkdown(doc, collection.id, { includeNotes: true })
  expect(withUnsharedOnly.itemCount).toBe(0)
  expect(withUnsharedOnly.noteCount).toEqual({ shared: 0, unshared: 1 })
})
