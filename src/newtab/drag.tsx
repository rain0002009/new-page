import { useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, pointerWithin, useSensor, useSensors, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core'
import { useSortable, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { children, todos, type Document, type Entity, type LinkInput } from '../core/model'
import type { Act } from './Editor'

type DragItem = { kind: 'space' | 'collection' | 'link' | 'todo'; entityId: string; title: string } | { kind: 'tab'; tab: LinkInput; title: string }

export function useDragItem(id: string, item: DragItem) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id, data: item, disabled: { droppable: item.kind === 'tab' } })
  return {
    ref: setNodeRef,
    ...attributes, role: undefined, ...listeners,
    style: { transform: CSS.Transform.toString(transform), transition },
    'data-dragging': isDragging || undefined,
    'data-drop-target': isOver || undefined,
  }
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
  const [dragging, setDragging] = useState<DragItem | null>(null)
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  function finish({ active, over }: DragEndEvent) {
    setDragging(null)
    const source = active.data.current as DragItem | undefined
    const target = over?.data.current as DragItem | undefined
    if (!source || !target || active.id === over?.id || target.kind === 'tab') return
    if (source.kind === 'todo') {
      if (target.kind === 'todo') void act({ type: 'sort-todo', id: source.entityId, beforeId: beforeId(todos(doc), source.entityId, target.entityId) })
      return
    }
    const entity = doc.entities[target.entityId]
    if (!entity) return
    if (source.kind === 'tab') {
      const parentId = target.kind === 'collection' ? entity.id : target.kind === 'link' ? entity.parentId : null
      if (parentId) void act({ type: 'add-links', parentId, links: [source.tab] })
      return
    }
    const moving = doc.entities[source.entityId]
    if (!moving) return
    if (source.kind === target.kind) {
      void act({ type: 'move', id: moving.id, parentId: entity.parentId, beforeId: beforeId(children(doc, entity.parentId).filter(e => e.kind === moving.kind), moving.id, entity.id) })
    } else if (source.kind === 'link' && (target.kind === 'collection' || target.kind === 'space')) {
      void act({ type: 'move', id: moving.id, parentId: entity.id })
    }
  }
  return <DndContext sensors={sensors} collisionDetection={collision} onDragStart={({ active }) => setDragging(active.data.current as DragItem)} onDragEnd={finish} onDragCancel={() => setDragging(null)} accessibility={{ screenReaderInstructions: { draggable: '按空格开始拖动，使用方向键调整位置，再按空格放下，Escape 取消。' } }}>
    {content}
    <DragOverlay dropAnimation={null} zIndex={50}>{dragging && <div className="drag-preview" aria-hidden="true">{dragging.title}</div>}</DragOverlay>
  </DndContext>
}
