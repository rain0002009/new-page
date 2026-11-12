import { useCallback, useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDndContext, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DropAnimation, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { children, todos, type Document, type Entity } from '../core/model'
import type { Act } from './Editor'
import DragPreview, { animateDrop, snapshotElement } from './DragPreview'
import { canSortTabs, closeCollectedTab, tabLink, type OpenTab } from './open-tabs'
import type { QuickCollectionTarget } from './QuickCollectionGap'

type DragItem = { kind: 'space' | 'collection' | 'link' | 'todo'; entityId: string; title: string } | { kind: 'tab'; tab: OpenTab; title: string }
type DragTarget = DragItem | { kind: 'content' } | QuickCollectionTarget
type DropDestination = { kind: 'existing' } | { kind: 'new-link'; collectionId?: string }

export function useDragItem(id: string, item: DragItem, className: string, disabled = false) {
  const node = useRef<HTMLElement | null>(null)
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id, data: { ...item, node }, disabled })
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
  return <div ref={setNodeRef} data-motion-id="drop-slot" className="card-placeholder min-h-[124px] rounded-[15px] bg-[#d5e1c680] border-[1.5px] border-dashed border-[#9caf88] animate-placeholder-in" role="img" aria-label="收藏放置位置" style={{ height }} />
}

const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return
  event.preventDefault()
  const { active, collisionRect, droppableContainers, droppableRects } = args.context
  if (!collisionRect) return
  const sourceKind = active?.data.current?.kind
  const sourceTab = sourceKind === 'tab' ? active?.data.current?.tab as OpenTab : undefined
  const linkSource = sourceKind === 'link' || sourceKind === 'tab'
  const center = { x: collisionRect.left + collisionRect.width / 2, y: collisionRect.top + collisionRect.height / 2 }
  const inbox = sourceTab ? active?.data.current?.node.current?.closest('.tab-inbox')?.getBoundingClientRect() as DOMRect | undefined : undefined
  const inboxVertical = inbox && center.x >= inbox.left && center.x <= inbox.right && ['ArrowUp', 'ArrowDown'].includes(event.code)
  let distance = Infinity
  let result: { x: number; y: number } | undefined
  for (const container of droppableContainers.getEnabled()) {
    const kind = container.data.current?.kind
    if (inboxVertical && kind !== 'tab') continue
    const tabTarget = sourceTab && kind === 'tab' && canSortTabs(sourceTab, container.data.current?.tab)
    if (container.id === active?.id || !(linkSource ? tabTarget || ['link', 'collection', 'new-collection'].includes(kind) : kind === sourceKind)) continue
    if (linkSource && kind === 'collection' && container.node.current?.querySelector('.link-card')) continue
    if (kind === 'new-collection' && ['ArrowLeft', 'ArrowRight'].includes(event.code)) continue
    const rect = droppableRects.get(container.id)
    if (!rect) continue
    const dx = (kind === 'new-collection' ? Math.max(rect.left + 1, Math.min(center.x, rect.right - 1)) : rect.left + rect.width / 2) - center.x
    const dy = rect.top + rect.height / 2 - center.y
    const forward = event.code === 'ArrowUp' ? dy < -1 : event.code === 'ArrowDown' ? dy > 1 : event.code === 'ArrowLeft' ? dx < -1 : dx > 1
    const nextDistance = Math.hypot(dx, dy)
    if (forward && nextDistance < distance) {
      distance = nextDistance
      result = { x: args.currentCoordinates.x + dx, y: args.currentCoordinates.y + dy }
    }
  }
  return result
}

const collision: CollisionDetection = args => {
  const kind = (args.active.data.current as DragItem | undefined)?.kind
  const source = args.active.data.current as DragItem | undefined
  const droppableContainers = args.droppableContainers.filter(container => {
    const item = container.data.current as DragTarget | undefined
    const target = item?.kind
    if (source?.kind === 'tab' && item?.kind === 'tab') return canSortTabs(source.tab, item.tab)
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

export function DragBoard({ doc, act, notify, moveTab, children: content }: { doc: Document; act: Act; notify: (message: string) => void; moveTab: (source: OpenTab, target: OpenTab) => Promise<boolean>; children: ReactNode }) {
  const [dragging, setDragging] = useState<HTMLElement | null>(null)
  const dragSource = useRef<DragItem | undefined>(undefined)
  const dropTargets = useRef(new Map<string, Promise<HTMLElement | null>>())
  const resolveDrop = useRef<(node: HTMLElement | null) => void>(() => {})
  const dropAnimation: DropAnimation = async args => {
    const destination = dropTargets.current.get(String(args.active.id))
    await animateDrop(args, destination ? await destination : null)
    if (dropTargets.current.get(String(args.active.id)) === destination) dropTargets.current.delete(String(args.active.id))
  }
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }))
  async function finish({ active, over }: DragEndEvent) {
    setDragging(null)
    const source = dragSource.current
    const target = over?.data.current as DragTarget | undefined
    const original = active.data.current?.node.current as HTMLElement | null
    const resolve = resolveDrop.current
    const settle = async (success: boolean, target: DropDestination = { kind: 'existing' }) => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const destination = target.kind === 'new-link' ? Array.from(document.querySelectorAll<HTMLElement>(target.collectionId ? `[data-drag-id="${window.CSS.escape(target.collectionId)}"] .card-grid > .link-card` : '.card-grid > .link-card')).find(node => !doc.entities[node.dataset.dragId!]) : document.querySelector<HTMLElement>(`[data-drag-id="${window.CSS.escape(String(active.id))}"]`)
      resolve(success ? destination ?? original : original)
    }
    if (!source || !target || active.id === over?.id || target.kind === 'content') { resolve(original); return }
    if (target.kind === 'tab') {
      if (source.kind === 'tab' && canSortTabs(source.tab, target.tab)) await settle(await moveTab(source.tab, target.tab))
      else resolve(original)
      return
    }
    if (target.kind === 'new-collection') {
      if (!target.ready || (source.kind !== 'link' && source.kind !== 'tab')) { resolve(original); return }
      const success = await act({ type: 'create-collection-with-link', parentId: target.spaceId, beforeId: target.beforeId, source: source.kind === 'tab' ? { kind: 'new', link: tabLink(source.tab) } : { kind: 'link', id: source.entityId } })
      await settle(success, source.kind === 'tab' ? { kind: 'new-link' } : { kind: 'existing' })
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
        await settle(success, { kind: 'new-link', collectionId: parentId })
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
  const tab = source?.kind === 'tab' ? source.tab : undefined
  const card = !!tab && !!target && ['content', 'collection', 'link', 'new-collection'].includes(target.kind)
  const collectionId = target?.kind === 'collection' ? target.entityId : target?.kind === 'link' ? doc.entities[target.entityId]?.parentId ?? undefined : undefined
  return <DragOverlay dropAnimation={dropAnimation} zIndex={50}>{element && <DragPreview element={element} tab={tab} card={card} collectionId={collectionId} />}</DragOverlay>
}
