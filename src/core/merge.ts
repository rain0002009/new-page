import {
  equal,
  isActive,
  parents,
  readDocument,
  tagKey,
  type Conflict,
  type Document,
  type Entity,
  type Tag,
  type TaggedEntity,
} from './model'

export const emptyDocument = (): Document => ({ format: 'new-page', version: 1, entities: {} })
export function refreshConflicts(previous: Conflict[], next: Conflict[], doc: Document, remote: Document): Conflict[] {
  const result = new Map(next.map(value => [value.entityId, value]))
  for (const value of previous) {
    if (result.has(value.entityId)) continue
    const localEntity = doc.entities[value.entityId] ?? null
    const remoteEntity = remote.entities[value.entityId] ?? null
    const content = (entity: Entity | null) => entity ? { ...entity, updatedAt: 0 } : null
    if (equal(content(localEntity), content(remoteEntity))) continue
    result.set(value.entityId, {
      ...value, local: localEntity, remote: remoteEntity,
      localParents: localEntity && isActive(doc, localEntity) ? parents(doc, localEntity) : value.localParents,
      remoteParents: remoteEntity ? parents(remote, remoteEntity) : [],
      remoteSpace: value.remoteSpace ? Object.values(remote.entities).find(entity => entity.kind === 'space' && isActive(remote, entity)) : undefined,
    })
  }
  return [...result.values()]
}
type TaggedRecord = Extract<Entity, { kind: 'collection' | 'link' | 'note' }>
function isTag(entity: Entity | undefined): entity is Tag {
  return entity?.kind === 'tag'
}
function isTagged(entity: Entity | undefined): entity is TaggedRecord {
  return entity?.kind === 'collection' || entity?.kind === 'link' || entity?.kind === 'note'
}
function withTagAliases(doc: Document, aliases: Map<string, string>, canonicalTags: Map<string, Tag>): Document {
  const next = structuredClone(doc)
  for (const entity of Object.values(next.entities)) {
    if (isTagged(entity) && entity.tagIds?.length) {
      entity.tagIds = [...new Set(entity.tagIds.map(id => aliases.get(id) ?? id))]
    }
  }
  for (const [id, entity] of Object.entries(next.entities)) {
    if (!isTag(entity)) continue
    const canonicalId = aliases.get(id) ?? id
    if (canonicalId !== id) delete next.entities[id]
    else if (!next.entities[canonicalId] && canonicalTags.has(canonicalId)) next.entities[canonicalId] = structuredClone(canonicalTags.get(canonicalId)!)
  }
  return next
}
function prepareTagMerge(base: Document, local: Document, remote: Document) {
  const docs = [structuredClone(base), structuredClone(local), structuredClone(remote)]
  const aliases = new Map<string, string>()
  const canonicalTags = new Map<string, Tag>()
  const forcedDeletions = new Map<string, Tag>()
  for (const doc of docs) {
    for (const entity of Object.values(doc.entities)) {
      if (isTag(entity) && (entity.purged || entity.deletedAt !== null)) forcedDeletions.set(entity.id, entity)
    }
  }
  for (const [id, source] of forcedDeletions) {
    const tombstone = structuredClone(source)
    tombstone.id = id
    tombstone.deletedAt ??= Date.now()
    tombstone.deletedBy ??= id
    tombstone.purged = true
    aliases.set(id, id)
    canonicalTags.set(id, tombstone)
    for (const doc of docs) {
      for (const entity of Object.values(doc.entities)) {
        if (isTagged(entity)) entity.tagIds = (entity.tagIds ?? []).filter(tagId => tagId !== id)
        if (isTag(entity) && entity.id === id) delete doc.entities[id]
      }
      doc.entities[id] = structuredClone(tombstone)
    }
  }
  const groups = new Map<string, Map<string, Tag>>()
  for (const doc of docs) {
    for (const entity of Object.values(doc.entities)) {
      if (!isTag(entity)) continue
      const key = tagKey(entity)
      const group = groups.get(key) ?? new Map<string, Tag>()
      group.set(entity.id, entity)
      groups.set(key, group)
    }
  }
  for (const group of groups.values()) {
    const entries = [...group.entries()]
    const deleted = entries.find(([, entity]) => entity.purged || entity.deletedAt !== null)?.[1]
    const baseId = entries.find(([id]) => base.entities[id])?.[0]
    const canonicalId = deleted?.id ?? baseId ?? entries.map(([id]) => id).sort()[0]
    const canonical = structuredClone(deleted ?? group.get(canonicalId)!)
    canonical.id = canonicalId
    if (deleted) {
      canonical.deletedAt ??= Date.now()
      canonical.deletedBy ??= canonicalId
      canonical.purged = true
    }
    canonicalTags.set(canonicalId, canonical)
    for (const id of group.keys()) aliases.set(id, canonicalId)
    for (const doc of docs) {
      for (const entity of Object.values(doc.entities)) {
        if (isTagged(entity)) entity.tagIds = (entity.tagIds ?? []).filter(tagId => (aliases.get(tagId) ?? tagId) !== canonicalId || !deleted)
        if (isTag(entity) && (aliases.get(entity.id) ?? entity.id) === canonicalId) delete doc.entities[entity.id]
      }
      doc.entities[canonicalId] = structuredClone(canonical)
    }
  }
  return docs.map(doc => withTagAliases(doc, aliases, canonicalTags)) as [Document, Document, Document]
}
function mergeTaggedLists(doc: Document, base: Document, local: Document, remote: Document) {
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!isTagged(entity)) continue
    const b = base.entities[id], l = local.entities[id], r = remote.entities[id]
    const baseIds = isTagged(b) ? b.tagIds ?? [] : []
    const localIds = isTagged(l) ? l.tagIds ?? [] : []
    const remoteIds = isTagged(r) ? r.tagIds ?? [] : []
    const baseSet = new Set(baseIds), localSet = new Set(localIds), remoteSet = new Set(remoteIds)
    const survivors = new Set([...localIds, ...remoteIds].filter(tagId =>
      !baseSet.has(tagId) || (localSet.has(tagId) && remoteSet.has(tagId))
    ))
    entity.tagIds = [
      ...baseIds.filter(tagId => survivors.has(tagId)),
      ...localIds.filter(tagId => !baseSet.has(tagId) && survivors.has(tagId)),
      ...remoteIds.filter(tagId => !baseSet.has(tagId) && !localSet.has(tagId) && survivors.has(tagId)),
    ]
  }
}
function conflict(id: string, fields: string[], local: Document, remote: Document): Conflict {
  const l = local.entities[id] ?? null, r = remote.entities[id] ?? null
  return { id, entityId: id, fields, local: l, remote: r, localParents: l ? parents(local, l) : [], remoteParents: r ? parents(remote, r) : [] }
}
export function merge(inputBase: Document, inputLocal: Document, inputRemote: Document) {
  const [base, local, remote] = prepareTagMerge(inputBase, inputLocal, inputRemote)
  const doc = emptyDocument(), conflicts: Conflict[] = []
  const ids = new Set([...Object.keys(base.entities), ...Object.keys(local.entities), ...Object.keys(remote.entities)])
  for (const id of ids) {
    const b = base.entities[id], l = local.entities[id], r = remote.entities[id]
    if (equal(l, r) || equal(r, b)) { if (l) doc.entities[id] = structuredClone(l); continue }
    if (equal(l, b)) { if (r) doc.entities[id] = structuredClone(r); continue }
    if (!l || !r || l.kind !== r.kind || !b) {
      if (l || r) doc.entities[id] = structuredClone(l ?? r)
      conflicts.push(conflict(id, ['内容'], local, remote)); continue
    }
    if ((l.deletedAt !== b.deletedAt || r.deletedAt !== b.deletedAt || l.purged !== b.purged || r.purged !== b.purged) && !equal(l, r)) {
      doc.entities[id] = structuredClone(l)
      conflicts.push(conflict(id, ['删除与编辑'], local, remote)); continue
    }
    const result = structuredClone(l) as unknown as Record<string, unknown>
    const bv = b as unknown as Record<string, unknown>, lv = l as unknown as Record<string, unknown>, rv = r as unknown as Record<string, unknown>
    const fields: string[] = []
    for (const field of Object.keys(rv)) {
      if (field === 'updatedAt') { result[field] = Math.max(l.updatedAt, r.updatedAt); continue }
      if (equal(lv[field], rv[field]) || equal(rv[field], bv[field])) continue
      if (equal(lv[field], bv[field])) result[field] = rv[field]
      else fields.push(field)
    }
    doc.entities[id] = result as unknown as Entity
    if (fields.length) conflicts.push(conflict(id, fields, local, remote))
  }
  mergeTaggedLists(doc, base, local, remote)
  for (let index = conflicts.length - 1; index >= 0; index--) {
    const value = conflicts[index]
    value.fields = value.fields.filter(field => field !== 'tagIds')
    if (!value.fields.length) conflicts.splice(index, 1)
  }
  // A remote parent deletion and a local child edit are also a conflict.
  for (const entity of Object.values(doc.entities)) {
    if (entity.deletedAt !== null || entity.purged || isActive(doc, entity)) continue
    if (!conflicts.some(c => c.entityId === entity.id)) conflicts.push(conflict(entity.id, ['所属位置被删除'], local, remote))
  }
  if (!Object.values(doc.entities).some(e => e.kind === 'space' && isActive(doc, e))) {
    const candidate = Object.values(local.entities).find(e => e.kind === 'space' && isActive(local, e))
    const remoteSpace = Object.values(remote.entities).find(e => e.kind === 'space' && isActive(remote, e))
    if (candidate) {
      // Keep a usable space while the two deletion choices remain available.
      doc.entities[candidate.id] = structuredClone(candidate)
      const existing = conflicts.find(c => c.entityId === candidate.id)
      const choice = existing ?? conflict(candidate.id, ['最后一个空间'], local, remote)
      choice.localSpace = structuredClone(candidate)
      choice.remoteSpace = remoteSpace ? structuredClone(remoteSpace) : undefined
      if (!existing) conflicts.push(choice)
    }
  }
  return { doc: readDocument(doc), conflicts }
}
export function resolveConflict(doc: Document, value: Conflict, side: 'local' | 'remote') {
  const next = structuredClone(doc), selected = value[side]
  if (!selected) { delete next.entities[value.entityId]; return next }
  next.entities[value.entityId] = structuredClone(selected)
  if (selected.deletedAt === null && !selected.purged) {
    for (const parent of value[`${side}Parents`]) if (!next.entities[parent.id] || next.entities[parent.id].deletedAt !== null) {
      next.entities[parent.id] = { ...structuredClone(parent), deletedAt: null, deletedBy: null, purged: false }
    }
  } else {
    for (const item of Object.values(next.entities)) if (item.id !== selected.id && parents(next, item).some(p => p.id === selected.id) && item.deletedAt === null) {
      item.deletedAt = selected.deletedAt ?? Date.now(); item.deletedBy = selected.id
    }
  }
  if (!Object.values(next.entities).some(entity => entity.kind === 'space' && isActive(next, entity))) {
    const fallback = value[side === 'local' ? 'localSpace' : 'remoteSpace']
    if (fallback) next.entities[fallback.id] = structuredClone(fallback)
  }
  return next
}
