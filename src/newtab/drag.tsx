import { useCallback, useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDndContext, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DropAnimation } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { children, todos, type Document, type Entity } from '../core/model'
import type { Act } from './Editor'
import DragPreview, { animateDrop, snapshotElement } from './DragPreview'
import { closeCollectedTab, tabLink, type OpenTab } from './open-tabs'
import { collectionKeyboardCoordinates, type QuickCollectionTarget } from './QuickCollectionGap'

type DragItem = { kind: 'space' | 'collection' | 'link' | 'todo'; entityId: string; title: string } | { kind: 'tab'; tab: OpenTab; title: string }
type DragTarget = DragItem | { kind: 'content' } | QuickCollectionTarget

export function useDragItem(id: string, item: DragItem, className: string, disabled = false) {
  const node = useRef<HTMLElement | null>(null)
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id, data: { ...item, node }, disabled: { draggable: disabled, droppable: disabled || item.kind === 'tab' } })
  const ref = useCallback((element: HTMLElement | null) => { node.current = element; setNodeRef(element); setActivatorNodeRef(element) }, [setNodeRef, setActivatorNodeRef])
  return disabled ? { className } : {
    className: `${className} cursor-grab data-[dragging]:z-2 data-[dragging]:!bg-[#d5e1c680] data-[dragging]:!shadow-none data-[dragging]:[outline:1.5px_dashed_#9caf88] data-[dragging]:outline-offset-[-1px] [&[data-dragging]>*]:invisible [&[data-dragging]::before]:hidden [&[data-drop-target]:not([data-dragging])]:[outline:2px_solid_#b2c495] ${item.kind === 'todo' ? '[&[data-drop-target]:not([data-dragging])]:outline-offset-[-2px]' : '[&[data-drop-target]:not([data-dragging])]:outline-offset-[3px]'}`,
    ref,
    ...attributes, role: undefined, ...listeners,
    style: { transform: CSS.Translate.toString(transform), transition },
    'data-dragging': isDragging || undefined,
    'data-drop-target': isOver || undefined,
    'data-drag-id': id,
  }
}

export function useCollectionPlaceholder(doc: Document, collectionId: string) {
  const { active, over } = useDndContext()
  const source = active?.data.current as DragItem | undefined
  const target = over?.data.current as DragItem | undefined
  if (!source || !target || (source.kind !== 'tab' && source.kind !== 'link') || (target.kind !== 'link' && target.kind !== 'collection')) return null
  const parentId = target.kind === 'collection' ? target.entityId : doc.entities[target.entityId]?.parentId
  if (parentId !== collectionId) return null
  if (source.kind === 'link' && doc.entities[source.entityId]?.parentId === collectionId) return null
  if (source.kind === 'link' && doc.entities[doc.entities[source.entityId]?.parentId ?? '']?.parentId !== doc.entities[collectionId]?.parentId) return null
  return { beforeId: target.kind === 'link' ? target.entityId : undefined, height: source.kind === 'link' ? active!.rect.current.initial?.height : undefined, target }
}

export function CollectionPlaceholder({ collectionId, target, height }: { collectionId: string; target: DragItem; height?: number }) {
  const { setNodeRef } = useDroppable({ id: `drop-slot:${collectionId}`, data: target })
  return <div ref={setNodeRef} className="card-placeholder min-h-[124px] rounded-[15px] bg-[#d5e1c680] border-[1.5px] border-dashed border-[#9caf88] animate-placeholder-in" role="img" aria-label="收藏放置位置" style={{ height }} />
}

const collision: CollisionDetection = args => {
  const kind = (args.active.data.current as DragItem | undefined)?.kind
  const droppableContainers = args.droppableContainers.filter(container => {
    const target = (container.data.current as DragTarget | undefined)?.kind
    if (kind === 'todo' || kind === 'space' || kind === 'collection') return target === kind
    return target === 'link' || target === 'collection' || target === 'content' || target === 'new-collection' || (kind === 'link' && target === 'space')
  })
  const scoped = { ...args, droppableContainers }
  const pointerCoordinates = args.pointerCoordinates ?? ((kind === 'link' || kind === 'tab') ? { x: args.collisionRect.left + args.collisionRect.width / 2, y: args.collisionRect.top + args.collisionRect.height / 2 } : null)
  return pointerCoordinates ? pointerWithin({ ...scoped, pointerCoordinates }).sort((a, b) => {
    const aKind = droppableContainers.find(c => c.id === a.id)?.data.current?.kind
    const bKind = droppableContainers.find(c => c.id === b.id)?.data.current?.kind
    const rank = (kind: string) => kind === 'content' ? 2 : kind === 'collection' ? 1 : 0
    return rank(aKind) - rank(bKind)
  }) : closestCenter(scoped)
}

function beforeId(siblings: Entity[], source: string, target: string) {
  const from = siblings.findIndex(e => e.id === source)
  const to = siblings.findIndex(e => e.id === target)
  return from >= 0 && from < to ? siblings[to + 1]?.id : target
}

export function DragBoard({ doc, act, notify, children: content }: { doc: Document; act: Act; notify: (message: string) => void; children: ReactNode }) {
  const [dragging, setDragging] = useState<HTMLElement | null>(null)
  const dragSource = useRef<DragItem | undefined>(undefined)
  const dropTargets = useRef(new Map<string, Promise<HTMLElement | null>>())
  const resolveDrop = useRef<(node: HTMLElement | null) => void>(() => {})
  const dropAnimation: DropAnimation = async args => {
    const destination = dropTargets.current.get(String(args.active.id))
    await animateDrop(args, destination ? await destination : null)
    dropTargets.current.delete(String(args.active.id))
  }
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: collectionKeyboardCoordinates }))
  async function finish({ active, over }: DragEndEvent) {
    setDragging(null)
    const source = dragSource.current
    const target = over?.data.current as DragTarget | undefined
    const original = active.data.current?.node.current as HTMLElement | null
    const resolve = resolveDrop.current
    const settle = async (success: boolean, collectionId?: string | true) => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const destination = collectionId ? Array.from(document.querySelectorAll<HTMLElement>(collectionId === true ? '.card-grid > .link-card' : `[data-drag-id="${window.CSS.escape(collectionId)}"] .card-grid > .link-card`)).find(node => !doc.entities[node.dataset.dragId!]) : document.querySelector<HTMLElement>(`[data-drag-id="${window.CSS.escape(String(active.id))}"]`)
      resolve(success ? destination ?? original : original)
    }
    if (!source || !target || active.id === over?.id || target.kind === 'tab' || target.kind === 'content') { resolve(original); return }
    if (target.kind === 'new-collection') {
      if (!target.ready || (source.kind !== 'link' && source.kind !== 'tab')) { resolve(original); return }
      const success = await act({ type: 'create-collection-with-link', parentId: target.spaceId, beforeId: target.beforeId, source: source.kind === 'tab' ? { kind: 'new', link: tabLink(source.tab) } : { kind: 'link', id: source.entityId } })
      await settle(success, source.kind === 'tab' ? true : undefined)
      if (success && source.kind === 'tab') await closeCollectedTab(source.tab, notify)
      return
    }
    if (source.kind === 'todo') {
      if (target.kind === 'todo') await settle(await act({ type: 'sort-todo', id: source.entityId, beforeId: beforeId(todos(doc), source.entityId, target.entityId) }))
      else resolve(original)
      return
    }
    const entity = doc.entities[target.entityId]
    if (!entity) { resolve(original); return }
    if (source.kind === 'tab') {
      const parentId = target.kind === 'collection' ? entity.id : target.kind === 'link' ? entity.parentId : null
      if (parentId) {
        const success = await act({ type: 'add-links', parentId, links: [tabLink(source.tab)], beforeId: target.kind === 'link' ? target.entityId : undefined })
        await settle(success, parentId)
        if (success) await closeCollectedTab(source.tab, notify)
      }
      else resolve(original)
      return
    }
    const moving = doc.entities[source.entityId]
    if (!moving) { resolve(original); return }
    if (source.kind === target.kind) {
      await settle(await act({ type: 'move', id: moving.id, parentId: entity.parentId, beforeId: beforeId(children(doc, entity.parentId).filter(e => e.kind === moving.kind), moving.id, entity.id) }))
    } else if (source.kind === 'link' && (target.kind === 'collection' || target.kind === 'space')) {
      await settle(await act({ type: 'move', id: moving.id, parentId: entity.id }))
    } else resolve(original)
  }
  return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={({ active }) => {
    const item = active.data.current as DragItem | undefined
    dragSource.current = item?.kind === 'tab' ? { ...item, tab: { ...item.tab } } : item
    const node = active.data.current?.node.current as HTMLElement | null
    const snapshot = node ? snapshotElement(node) : null
    const destination = new Promise<HTMLElement | null>(resolve => { resolveDrop.current = resolve })
    dropTargets.current.set(String(active.id), destination)
    setDragging(snapshot)
  }} onDragEnd={event => { void finish(event) }} onDragCancel={({ active }) => { resolveDrop.current(active.data.current?.node.current ?? null); setDragging(null) }} accessibility={{ screenReaderInstructions: { draggable: '按空格开始拖动，使用方向键调整位置，再按空格放下，Escape 取消。' } }}>
    {content}
    <DragFeedback element={dragging} source={dragSource.current} doc={doc} dropAnimation={dropAnimation} />
  </DndContext>
}

function DragFeedback({ element, source, doc, dropAnimation }: { element: HTMLElement | null; source?: DragItem; doc: Document; dropAnimation: DropAnimation }) {
  const { over } = useDndContext()
  const target = over?.data.current as DragTarget | undefined
  const tab = source?.kind === 'tab' && target && ['content', 'collection', 'link', 'new-collection'].includes(target.kind) ? source.tab : undefined
  const collectionId = target?.kind === 'collection' ? target.entityId : target?.kind === 'link' ? doc.entities[target.entityId]?.parentId ?? undefined : undefined
  return <DragOverlay dropAnimation={dropAnimation} zIndex={50}>{element && <DragPreview element={element} tab={tab} collectionId={collectionId} />}</DragOverlay>
}
