import { z } from 'zod'

const base = {
  id: z.string().min(1).max(100), title: z.string().max(1000),
  parentId: z.string().nullable(), position: z.number().finite(),
  updatedAt: z.number().finite(), deletedAt: z.number().finite().nullable(),
  deletedBy: z.string().nullable(), purged: z.boolean(),
}
const entitySchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('profile'), seeApiKey: z.string().optional(), fluidAnimation: z.boolean().optional() }),
  z.object({ ...base, kind: z.literal('space') }),
  z.object({ ...base, kind: z.literal('collection'), collapsed: z.boolean() }),
  z.object({ ...base, kind: z.literal('note'), body: z.string() }),
  z.object({ ...base, kind: z.literal('link'), url: z.string().max(10_000), icon: z.string().max(250_000), note: z.string().max(20_000), todo: z.boolean(), todoPosition: z.number().finite().optional() }),
])
const documentSchema = z.object({
  format: z.literal('new-page'), version: z.literal(1),
  entities: z.record(z.string(), entitySchema),
})
export type Entity = z.infer<typeof entitySchema>
export type Link = Extract<Entity, { kind: 'link' }>
export type Note = Extract<Entity, { kind: 'note' }>
export type SavedItem = Link | Note
export type Collection = Extract<Entity, { kind: 'collection' }>
export type Document = z.infer<typeof documentSchema>
export type Conflict = {
  id: string; entityId: string; fields: string[]
  local: Entity | null; remote: Entity | null
  localParents: Entity[]; remoteParents: Entity[]
  localSpace?: Entity; remoteSpace?: Entity
}
export type LinkInput = { title: string; url: string; icon?: string; note?: string }
export type Action =
  | { type: 'add-space'; title: string }
  | { type: 'add-collection'; parentId: string; title: string }
  | { type: 'add-note'; parentId: string; id: string }
  | { type: 'add-links'; parentId: string; links: LinkInput[]; beforeId?: string }
  | { type: 'collect-tabs'; parentId: string; title: string; links: LinkInput[] }
  | { type: 'create-collection-with-link'; parentId: string; beforeId?: string; source: { kind: 'link'; id: string } | { kind: 'new'; link: LinkInput } }
  | { type: 'edit'; id: string; patch: { title?: string; url?: string; note?: string; body?: string; collapsed?: boolean; seeApiKey?: string; fluidAnimation?: boolean } }
  | { type: 'todo'; id: string; value: boolean }
  | { type: 'sort-todo'; id: string; beforeId?: string }
  | { type: 'move'; id: string; parentId: string | null; beforeId?: string }
  | { type: 'delete'; id: string }
  | { type: 'restore'; id: string }
  | { type: 'purge'; id: string }
  | { type: 'empty-trash' }

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}
export const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b)
export function savedUrl(value: string) {
  const url = new URL(value)
  // Keep historical URL schemes readable in existing snapshots and backups.
  // The extension itself targets Chrome; these addresses do not imply browser support.
  if (!['https:', 'http:', 'chrome:', 'edge:', 'about:', 'chrome-extension:', 'moz-extension:', 'file:'].includes(url.protocol)) throw new Error('请输入网页、浏览器页面、扩展页面或本地文件的网址')
  return url.href
}
export function pageLabel(value: string) {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) ? url.hostname : url.href
}
export function safeIcon(value: string) {
  if (value.startsWith('data:image/') && value.length < 250_000) return value
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}
export function readDocument(value: unknown): Document {
  const result = documentSchema.safeParse(value)
  if (!result.success) throw new Error('数据格式不兼容或已损坏，原数据未被覆盖')
  const doc = result.data
  if (doc.entities.profile?.kind !== 'profile' || doc.entities.profile.deletedAt !== null || doc.entities.profile.purged) throw new Error('数据缺少有效用户资料')
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (id !== entity.id || id === '__proto__' || id === 'constructor') throw new Error('数据条目标识无效')
    if (entity.kind === 'link' && !entity.purged) {
      savedUrl(entity.url)
      entity.icon = safeIcon(entity.icon)
      entity.todoPosition ??= entity.position
    }
    const parent = entity.parentId ? doc.entities[entity.parentId] : null
    if (((entity.kind === 'link' || entity.kind === 'note') && parent?.kind !== 'collection') ||
        (entity.kind === 'collection' && parent?.kind !== 'space') ||
        (['profile', 'space'].includes(entity.kind) && entity.parentId !== null)) throw new Error('数据的空间与收藏块关系无效')
  }
  if (!active(doc).some(e => e.kind === 'space')) throw new Error('数据必须至少包含一个空间')
  return doc
}
export function parents(doc: Document, entity: Entity): Entity[] {
  const result: Entity[] = []
  let current = entity.parentId ? doc.entities[entity.parentId] : null
  while (current) {
    result.push(current)
    current = current.parentId ? doc.entities[current.parentId] : null
  }
  return result
}
export function isActive(doc: Document, entity: Entity) {
  return entity.deletedAt === null && !entity.purged && parents(doc, entity).every(p => p.deletedAt === null && !p.purged)
}
export function active(doc: Document): Entity[] { return Object.values(doc.entities).filter(e => isActive(doc, e)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)) }
export function children(doc: Document, parentId: string | null) { return active(doc).filter(e => e.parentId === parentId) }
export function todos(doc: Document): Link[] {
  return active(doc).filter((e): e is Link => e.kind === 'link' && e.todo).sort((a, b) =>
    (a.todoPosition ?? a.position) - (b.todoPosition ?? b.position) || a.id.localeCompare(b.id))
}
function common(kind: Entity['kind'], title: string, parentId: string | null, position = 1024) {
  return { id: kind === 'profile' ? 'profile' : crypto.randomUUID(), kind, title: title.trim() || '未命名', parentId, position, updatedAt: Date.now(), deletedAt: null, deletedBy: null, purged: false }
}
export function createDocument(nickname: string): Document {
  const profile = { ...common('profile', nickname, null), kind: 'profile' } as const
  const space = { ...common('space', '我的空间', null), kind: 'space' } as const
  const collection = { ...common('collection', '日常收藏', space.id), kind: 'collection', collapsed: false } as const
  return { format: 'new-page', version: 1, entities: { profile, [space.id]: space, [collection.id]: collection } }
}
function requireEntity(doc: Document, id: string, kind?: Entity['kind']) {
  const entity = doc.entities[id]
  if (!entity || !isActive(doc, entity) || (kind && entity.kind !== kind)) throw new Error('内容已改变，请刷新后重试')
  return entity
}
function appendPosition(doc: Document, parentId: string | null, kind: Entity['kind']) { return Math.max(0, ...children(doc, parentId).filter(e => e.kind === kind).map(e => e.position)) + 1024 }
function insertionPosition(siblings: Entity[], beforeId: string | undefined, now: number) {
  const index = beforeId ? siblings.findIndex(e => e.id === beforeId) : siblings.length
  if (index < 0) throw new Error('拖拽目标已改变')
  const between = () => index === siblings.length ? Math.max(0, siblings.at(-1)?.position ?? 0) + 1024 :
    ((siblings[index - 1]?.position ?? siblings[index].position - 2048) + siblings[index].position) / 2
  let position = between()
  // Concurrent edits and imports can share ranks; preserve the visible order
  // before inserting when no numeric gap remains.
  if (!Number.isFinite(position) || (index > 0 && position <= siblings[index - 1].position) ||
      (index < siblings.length && position >= siblings[index].position)) {
    siblings.forEach((entity, order) => { entity.position = (order + 1) * 1024; entity.updatedAt = now })
    position = between()
  }
  return position
}
export function apply(doc: Document, action: Action): Document {
  const next = readDocument(doc)
  const now = Date.now()
  const insertCollection = (parentId: string, title: string, beforeId?: string) => {
    requireEntity(next, parentId, 'space')
    const siblings = children(next, parentId).filter(e => e.kind === 'collection')
    const position = insertionPosition(siblings, beforeId, now)
    const collection: Collection = { ...common('collection', title, parentId, position), kind: 'collection', collapsed: false }
    next.entities[collection.id] = collection
    return collection
  }
  switch (action.type) {
    case 'add-space': {
      const entity = { ...common('space', action.title, null, appendPosition(next, null, 'space')), kind: 'space' } as const
      next.entities[entity.id] = entity
      break
    }
    case 'add-collection': insertCollection(action.parentId, action.title); break
    case 'add-note': {
      const collection = requireEntity(next, action.parentId, 'collection') as Collection
      if (next.entities[action.id]) throw new Error('此笔记已存在，请重新创建')
      next.entities[action.id] = { ...common('note', '新笔记', collection.id, insertionPosition(children(next, collection.id), undefined, now)), id: action.id, kind: 'note', body: '' }
      collection.collapsed = false; collection.updatedAt = now
      break
    }
    case 'collect-tabs': {
      if (!action.links.length) throw new Error('当前窗口没有可收藏的网页')
      const first = children(next, action.parentId).find(e => e.kind === 'collection')
      const collection = insertCollection(action.parentId, action.title, first?.id)
      return apply(next, { type: 'add-links', parentId: collection.id, links: action.links })
    }
    case 'create-collection-with-link': {
      if (!children(next, action.parentId).some(e => e.kind === 'collection')) throw new Error('请先创建一个收藏块')
      if (action.source.kind === 'link') {
        const link = requireEntity(next, action.source.id, 'link')
        const source = requireEntity(next, link.parentId!, 'collection')
        if (source.parentId !== action.parentId) throw new Error('链接不能跨空间移动')
      }
      const collection = insertCollection(action.parentId, '新收藏', action.beforeId)
      return apply(next, action.source.kind === 'link' ? { type: 'move', id: action.source.id, parentId: collection.id } : { type: 'add-links', parentId: collection.id, links: [action.source.link] })
    }
    case 'add-links': {
      if (!action.links.length) throw new Error('当前窗口没有可收藏的网页')
      const collection = requireEntity(next, action.parentId, 'collection') as Collection
      for (const input of action.links) {
        const url = savedUrl(input.url)
        const siblings = children(next, collection.id)
        const position = insertionPosition(siblings, action.beforeId, now)
        const link: Link = { ...common('link', input.title || pageLabel(url), collection.id, position), kind: 'link', url, icon: safeIcon(input.icon ?? ''), note: input.note ?? '', todo: false }
        next.entities[link.id] = link
      }
      collection.collapsed = false
      collection.updatedAt = now
      break
    }
    case 'edit': {
      const entity = requireEntity(next, action.id)
      if (action.patch.title !== undefined) entity.title = entity.kind === 'note' ? action.patch.title : action.patch.title.trim() || entity.title
      if (entity.kind === 'link') {
        if (action.patch.url !== undefined) entity.url = savedUrl(action.patch.url)
        if (action.patch.note !== undefined) entity.note = action.patch.note
      }
      if (entity.kind === 'collection' && action.patch.collapsed !== undefined) entity.collapsed = action.patch.collapsed
      if (entity.kind === 'note' && action.patch.body !== undefined) entity.body = action.patch.body
      if (entity.kind === 'profile') {
        if (action.patch.seeApiKey !== undefined) entity.seeApiKey = action.patch.seeApiKey.trim()
        if (action.patch.fluidAnimation !== undefined) entity.fluidAnimation = action.patch.fluidAnimation
      }
      entity.updatedAt = now
      break
    }
    case 'todo': {
      const entity = requireEntity(next, action.id, 'link') as Link
      if (action.value && !entity.todo) entity.todoPosition = Math.max(0, ...todos(next).map(e => e.todoPosition ?? e.position)) + 1024
      entity.todo = action.value; entity.updatedAt = now; break
    }
    case 'sort-todo': {
      const entity = requireEntity(next, action.id, 'link') as Link
      if (!entity.todo) throw new Error('此链接已不在待办中')
      if (action.beforeId === entity.id) break
      const siblings = todos(next).filter(e => e.id !== entity.id)
      const index = action.beforeId ? siblings.findIndex(e => e.id === action.beforeId) : siblings.length
      if (index < 0) throw new Error('拖拽目标已改变')
      const position = (link: Link) => link.todoPosition ?? link.position
      entity.todoPosition = index === siblings.length ? (siblings.at(-1) ? position(siblings.at(-1)!) : 0) + 1024 :
        ((siblings[index - 1] ? position(siblings[index - 1]) : position(siblings[index]) - 2048) + position(siblings[index])) / 2
      // Legacy collections and concurrent edits can have equal ranks. Rebalance
      // only when no numeric gap remains, preserving the requested global order.
      if (!Number.isFinite(entity.todoPosition) ||
          (index > 0 && entity.todoPosition <= position(siblings[index - 1])) ||
          (index < siblings.length && entity.todoPosition >= position(siblings[index]))) {
        siblings.splice(index, 0, entity)
        siblings.forEach((link, order) => {
          const rank = (order + 1) * 1024
          if (link.todoPosition !== rank) { link.todoPosition = rank; link.updatedAt = now }
        })
      }
      entity.updatedAt = now
      break
    }
    case 'move': {
      const entity = requireEntity(next, action.id)
      if (entity.kind === 'profile') throw new Error('此内容不能移动')
      if (entity.kind === 'link' || entity.kind === 'note') {
        if (!action.parentId || next.entities[action.parentId]?.kind !== 'collection') throw new Error('请拖入当前空间的收藏块，链接不能跨空间移动')
        const target = requireEntity(next, action.parentId!, 'collection') as Collection
        const source = next.entities[entity.parentId!]
        if (source.parentId !== target.parentId) throw new Error('链接不能跨空间移动')
        target.collapsed = false
      } else if (entity.parentId !== action.parentId) throw new Error('只能在原有区域内排序')
      const siblings = children(next, action.parentId).filter(e => (e.kind === entity.kind || (['link', 'note'].includes(entity.kind) && ['link', 'note'].includes(e.kind))) && e.id !== entity.id)
      entity.position = insertionPosition(siblings, action.beforeId, now)
      entity.parentId = action.parentId; entity.updatedAt = now
      break
    }
    case 'delete': {
      const entity = requireEntity(next, action.id)
      if (entity.kind === 'profile') throw new Error('不能删除用户资料')
      if (entity.kind === 'space' && active(next).filter(e => e.kind === 'space').length <= 1) throw new Error('请至少保留一个空间')
      const affected = active(next).filter(e => e.id === entity.id || parents(next, e).some(p => p.id === entity.id))
      for (const item of affected) { item.deletedAt = now; item.deletedBy = entity.id; item.updatedAt = now }
      if (entity.kind === 'note') purgeEntity(entity, now)
      break
    }
    case 'restore': {
      const entity = next.entities[action.id]
      if (!entity || entity.purged) throw new Error('内容已过保留期，无法恢复')
      const restoreGroup = (root: Entity) => {
        for (const p of parents(next, root).reverse()) if (p.deletedAt !== null) {
          if (p.purged) throw new Error('所属空间已过保留期，无法恢复')
          restoreGroup(next.entities[p.deletedBy ?? p.id] ?? p)
        }
        for (const item of Object.values(next.entities)) if (!item.purged && (item.id === root.id || item.deletedBy === root.id)) {
          item.deletedAt = null; item.deletedBy = null; item.updatedAt = now
        }
      }
      restoreGroup(entity)
      break
    }
    case 'purge': {
      const entity = next.entities[action.id]
      if (!entity || entity.deletedAt === null || entity.purged) throw new Error('回收站内容已改变，请刷新后重试')
      for (const item of Object.values(next.entities)) if (!item.purged && (item.id === entity.id || parents(next, item).some(parent => parent.id === entity.id))) {
        item.deletedAt ??= now
        item.deletedBy ??= entity.id
        purgeEntity(item, now)
      }
      break
    }
    case 'empty-trash': {
      const deleted = Object.values(next.entities).filter(item => !item.purged && !isActive(next, item))
      for (const item of deleted) {
        item.deletedAt ??= now
        item.deletedBy ??= item.id
        purgeEntity(item, now)
      }
      break
    }
  }
  return readDocument(next)
}
function purgeEntity(entity: Entity, now: number) {
  entity.purged = true; entity.title = ''; entity.updatedAt = now
  if (entity.kind === 'link') { entity.url = ''; entity.icon = ''; entity.note = ''; entity.todo = false }
  if (entity.kind === 'note') entity.body = ''
}
export function prune(doc: Document, now = Date.now()): Document {
  const next = structuredClone(doc)
  for (const e of Object.values(next.entities)) if (e.deletedAt !== null && now - e.deletedAt >= 30 * 86400_000 && !e.purged) {
    purgeEntity(e, now)
  }
  return next
}
