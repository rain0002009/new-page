import { useCallback, useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, useDndContext, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DropAnimation } from '@dnd-kit/core'
import { useSortable, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { children, todos, type Document, type Entity, type LinkInput } from '../core/model'
import type { Act } from './Editor'
import DragPreview, { animateDrop, snapshotElement } from './DragPreview'

type DragItem = { kind: 'space' | 'collection' | 'link' | 'todo'; entityId: string; title: string } | { kind: 'tab'; tab: LinkInput; title: string }

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
  return { beforeId: source.kind === 'link' && target.kind === 'link' ? target.entityId : undefined, height: source.kind === 'link' ? active!.rect.current.initial?.height : undefined, target }
}

export function CollectionPlaceholder({ collectionId, target, height }: { collectionId: string; target: DragItem; height?: number }) {
  const { setNodeRef } = useDroppable({ id: `drop-slot:${collectionId}`, data: target })
  return <div ref={setNodeRef} className="card-placeholder min-h-[124px] rounded-[15px] bg-[#d5e1c680] border-[1.5px] border-dashed border-[#9caf88] animate-placeholder-in" role="img" aria-label="收藏放置位置" style={{ height }} />
}

const collision: CollisionDetection = args => {
  const kind = (args.active.data.current as DragItem | undefined)?.kind
  const droppableContainers = args.droppableContainers.filter(container => {
    const target = (container.data.current as DragItem | undefined)?.kind
    if (kind === 'todo' || kind === 'space' || kind === 'collection') return target === kind
    return target === 'link' || target === 'collection' || (kind === 'link' && target === 'space')
  })
  const scoped = { ...args, droppableContainers }
  return args.pointerCoordinates ? pointerWithin(scoped).sort((a, b) => {
    const aKind = droppableContainers.find(c => c.id === a.id)?.data.current?.kind
    const bKind = droppableContainers.find(c => c.id === b.id)?.data.current?.kind
    return Number(aKind === 'collection') - Number(bKind === 'collection')
  }) : closestCenter(scoped)
}

function beforeId(siblings: Entity[], source: string, target: string) {
  const from = siblings.findIndex(e => e.id === source)
  const to = siblings.findIndex(e => e.id === target)
  return from >= 0 && from < to ? siblings[to + 1]?.id : target
}

export function DragBoard({ doc, act, children: content }: { doc: Document; act: Act; children: ReactNode }) {
  const [dragging, setDragging] = useState<HTMLElement | null>(null)
  const dropTargets = useRef(new WeakMap<HTMLElement, Promise<HTMLElement | null>>())
  const resolveDrop = useRef<(node: HTMLElement | null) => void>(() => {})
  const dropAnimation: DropAnimation = async args => {
    const snapshot = args.dragOverlay.node.querySelector<HTMLElement>('.drag-snapshot')
    const destination = snapshot && dropTargets.current.get(snapshot)
    await animateDrop(args, destination ? await destination : null)
  }
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  async function finish({ active, over }: DragEndEvent) {
    setDragging(null)
    const source = active.data.current as DragItem | undefined
    const target = over?.data.current as DragItem | undefined
    const original = active.data.current?.node.current as HTMLElement | null
    const resolve = resolveDrop.current
    const settle = async (success: boolean, collectionId?: string) => {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const destination = collectionId ? document.querySelector<HTMLElement>(`[data-drag-id="${window.CSS.escape(collectionId)}"] .card-grid > .link-card:last-child`) : document.querySelector<HTMLElement>(`[data-drag-id="${window.CSS.escape(String(active.id))}"]`)
      resolve(success ? destination ?? original : original)
    }
    if (!source || !target || active.id === over?.id || target.kind === 'tab') { resolve(original); return }
    if (source.kind === 'todo') {
      if (target.kind === 'todo') await settle(await act({ type: 'sort-todo', id: source.entityId, beforeId: beforeId(todos(doc), source.entityId, target.entityId) }))
      else resolve(original)
      return
    }
    const entity = doc.entities[target.entityId]
    if (!entity) { resolve(original); return }
    if (source.kind === 'tab') {
      const parentId = target.kind === 'collection' ? entity.id : target.kind === 'link' ? entity.parentId : null
      if (parentId) await settle(await act({ type: 'add-links', parentId, links: [source.tab] }), parentId)
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
    const node = active.data.current?.node.current as HTMLElement | null
    const snapshot = node ? snapshotElement(node) : null
    const destination = new Promise<HTMLElement | null>(resolve => { resolveDrop.current = resolve })
    if (snapshot) dropTargets.current.set(snapshot, destination)
    setDragging(snapshot)
  }} onDragEnd={event => { void finish(event) }} onDragCancel={({ active }) => { resolveDrop.current(active.data.current?.node.current ?? null); setDragging(null) }} accessibility={{ screenReaderInstructions: { draggable: '按空格开始拖动，使用方向键调整位置，再按空格放下，Escape 取消。' } }}>
    {content}
    <DragOverlay dropAnimation={dropAnimation} zIndex={50}>{dragging && <DragPreview element={dragging} />}</DragOverlay>
  </DndContext>
}
