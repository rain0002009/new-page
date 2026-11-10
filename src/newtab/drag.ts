import type { DragEvent } from 'react'
import type { Action, Document, LinkInput } from '../core/model'

const format = 'application/x-page-garden'
type Payload = { entityId: string } | { tab: LinkInput }
export function startDrag(event: DragEvent, payload: Payload) {
  event.stopPropagation()
  event.dataTransfer.setData(format, JSON.stringify(payload))
  event.dataTransfer.effectAllowed = 'copyMove'
}
export function allowDrop(event: DragEvent) {
  if (event.dataTransfer.types.includes(format)) { event.preventDefault(); event.stopPropagation() }
}
export function dropAction(event: DragEvent, doc: Document, parentId: string | null, beforeId?: string): Action | null {
  if (!event.dataTransfer.types.includes(format)) return null
  event.preventDefault(); event.stopPropagation()
  try {
    const value = JSON.parse(event.dataTransfer.getData(format)) as Payload
    if ('tab' in value && parentId && doc.entities[parentId]?.kind === 'collection') return { type: 'add-links', parentId, links: [value.tab] }
    if ('entityId' in value && value.entityId !== beforeId && doc.entities[value.entityId]) return { type: 'move', id: value.entityId, parentId, beforeId }
  } catch { /* Ignore unrelated or malformed drag data. */ }
  return null
}
