import { test, expect } from 'vitest'
import { active, apply, createDocument, type Document } from '../../src/core/model'
import { collectionToMarkdown } from '../../src/core/see'

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
  expect(result.content).not.toContain('#')
  expect(result.content).toContain('- **[GitHub](https://github.com/)**  \n  代码仓库托管与协作平台')
  expect(result.content).toContain('- **[TypeScript](https://www.typescriptlang.org/)**')
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
  expect(result.content).not.toContain('#')
  expect(result.content).toContain('- **[GitHub](https://github.com/)**  \n  代码仓库托管与协作平台')
  expect(result.content).toContain('- **[TypeScript](https://www.typescriptlang.org/)**')
  // 包含已分享笔记（带短链与摘要）
  expect(result.content).toContain('- 📝 **[架构备忘录](https://s.ee/arch-memo)**  \n  架构设计')
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

test('collectionToMarkdown 针对多行备注正确添加每行缩进引用，并自动忽略已过期的笔记短链', () => {
  let doc = createDocument('Tester')
  const collection = active(doc).find(entity => entity.kind === 'collection')!

  // 1. 添加带多行备注的链接
  doc = apply(doc, {
    type: 'add-links',
    parentId: collection.id,
    links: [
      {
        title: '多行备注工具',
        url: 'https://example.com/tool',
        note: '第一行说明\n第二行要点\n第三行总结',
      },
    ],
  })

  // 2. 添加一个已过期的笔记分享
  const expiredNoteId = 'expired-note-id'
  doc = apply(doc, { type: 'add-note', parentId: collection.id, id: expiredNoteId })
  doc = apply(doc, {
    type: 'edit',
    id: expiredNoteId,
    patch: { title: '过期笔记', body: '已过期的正文内容' },
  })
  doc = apply(doc, {
    type: 'add-share',
    id: 'expired-share-id',
    entityKind: 'note',
    entityId: expiredNoteId,
    domain: 's.ee',
    slug: 'expired-slug',
    shortUrl: 'https://s.ee/expired-slug',
    title: '已过期的公开笔记',
    expireAt: 1000000000, // 远早于当前时间（已过期）
  })

  const result = collectionToMarkdown(doc, collection.id, { includeNotes: true })
  // 多行备注每行均保持缩进，条目间空行隔开
  expect(result.content).toContain('- **[多行备注工具](https://example.com/tool)**  \n  第一行说明\n  第二行要点\n  第三行总结')

  // 已过期的笔记短链不被导出，且不计入 shared 数量
  expect(result.content).not.toContain('expired-slug')
  expect(result.content).not.toContain('过期笔记')
  expect(result.noteCount.shared).toBe(0)
  expect(result.noteCount.unshared).toBe(1)
  expect(result.itemCount).toBe(1)
})
