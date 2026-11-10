import { equal, isActive, parents, type Conflict, type Document, type Entity } from './model'

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
function conflict(id: string, fields: string[], local: Document, remote: Document): Conflict {
  const l = local.entities[id] ?? null, r = remote.entities[id] ?? null
  return { id, entityId: id, fields, local: l, remote: r, localParents: l ? parents(local, l) : [], remoteParents: r ? parents(remote, r) : [] }
}
export function merge(base: Document, local: Document, remote: Document) {
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
  return { doc, conflicts }
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
