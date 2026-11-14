import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react'
import { DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, getClientRect, pointerWithin, useDndContext, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DropAnimation, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { children, todos, type Document, type Entity } from '../core/model'
import type { Act } from './Editor'
import DragPreview, { animateDrop, snapshotElement } from './DragPreview'
import { canSortTabs, tabLink, type OpenTab } from './open-tabs'
import type { QuickCollectionTarget } from './QuickCollectionGap'
import { useSelection } from './Selection'
import { moveTabsToSlot, moveWholeGroup, type TabSlot } from './tab-groups'
import { closeSavedTabs, saveTabsBeforeClosing } from './tab-actions'

type DragItem = { kind: 'space' | 'collection' | 'todo'; entityId: string; title: string } | { kind: 'saved-item'; itemKind: 'link' | 'note'; entityId: string; title: string } | { kind: 'tab'; tab: OpenTab; title: string } | { kind: 'tab-group'; groupId: number; windowId: number; lastIndex: number; title: string }
type DragTarget = DragItem | { kind: 'content' } | QuickCollectionTarget | ({ kind: 'tab-slot' } & TabSlot)
type DropDestination = { kind: 'existing' } | { kind: 'new-link'; collectionId?: string }
type TabProjection = { tabs: OpenTab[]; height: number; width: number; slot?: TabSlot; target?: DragTarget }
const TabProjectionContext = createContext<TabProjection | null>(null)
export const useTabDragProjection = () => useContext(TabProjectionContext)

function tabDropSlot(source: OpenTab, target?: DragTarget): TabSlot | undefined {
  if (target?.kind === 'tab-slot') return target.windowId === source.windowId ? target : undefined
  if (target?.kind === 'tab-group') return target.windowId === source.windowId ? { windowId: target.windowId, groupId: target.groupId, index: target.lastIndex + 1 } : undefined
  if (target?.kind !== 'tab' || target.tab.windowId !== source.windowId || (target.tab.groupId === -1 && !canSortTabs(source, target.tab))) return
  const forward = source.index < target.tab.index
  return { windowId: target.tab.windowId, groupId: target.tab.groupId, index: target.tab.index + (forward ? 1 : 0), beforeTabId: forward ? undefined : target.tab.tabId }
}

// Read the final inbox layout, excluding both sortable and parent FLIP
// transforms. Sorting thresholds must follow the rows that have made room.
function inboxLayoutRects(rects: Parameters<CollisionDetection>[0]['droppableRects'], containers: Parameters<CollisionDetection>[0]['droppableContainers']) {
  const result = new Map(rects)
  for (const container of containers) {
    if (!['tab', 'tab-slot', 'tab-group'].includes(container.data.current?.kind)) continue
    const node = container.node.current
    if (!node) continue
    const rect = getClientRect(node, { ignoreTransform: true })
    const group = node.parentElement?.closest('.tab-group')
    const transform = group && getComputedStyle(group).transform
    const offset = new DOMMatrixReadOnly(!transform || transform === 'none' ? undefined : transform)
    result.set(container.id, { ...rect, top: rect.top - offset.m42, bottom: rect.bottom - offset.m42, left: rect.left - offset.m41, right: rect.right - offset.m41 })
  }
  return result
}

export function useDragItem(id: string, item: DragItem, className: string, disabled = false) {
  const selection = useSelection()
  const projection = useTabDragProjection()
  const node = useRef<HTMLElement | null>(null)
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging, isOver } = useSortable({ id, data: { ...item, node }, disabled: disabled || selection.busy })
  const ref = useCallback((element: HTMLElement | null) => { node.current = element; setNodeRef(element); setActivatorNodeRef(element) }, [setNodeRef, setActivatorNodeRef])
  const targetOutline = item.kind === 'tab' || item.kind === 'tab-group' ? '' : `[&[data-drop-target]:not([data-dragging])]:[outline:2px_solid_#b2c495] ${item.kind === 'todo' ? '[&[data-drop-target]:not([data-dragging])]:outline-offset-[-2px]' : '[&[data-drop-target]:not([data-dragging])]:outline-offset-[3px]'}`
  const projecting = !!projection?.slot && (item.kind === 'tab' || item.kind === 'tab-group')
  const projectedSource = projecting && item.kind === 'tab' && projection.tabs.some(tab => tab.tabId === item.tab.tabId)
  return disabled ? { className } : {
    className: `${className} cursor-grab data-[selected]:[outline:2px_solid_#829b65] data-[selected]:outline-offset-[-2px] data-[dragging]:z-2 data-[dragging]:!bg-[#d5e1c680] data-[dragging]:!shadow-none data-[dragging]:[outline:1.5px_dashed_#9caf88] data-[dragging]:outline-offset-[-1px] [&[data-dragging]>*]:invisible [&[data-dragging]::before]:hidden ${targetOutline}`,
    ref,
    ...attributes, role: undefined, ...listeners,
    style: projectedSource ? { position: 'absolute' as const, height: projection.height, width: projection.width, opacity: 0, pointerEvents: 'none' as const } : { transform: projecting ? undefined : CSS.Translate.toString(transform), transition: projecting ? undefined : transition },
    'data-dragging': isDragging || undefined,
    'data-drop-target': isOver || undefined,
    'data-drag-id': id,
  }
}

export function useCollectionPlaceholder(doc: Document, collectionId: string) {
  const { active, over } = useDndContext()
  const source = active?.data.current as DragItem | undefined
  const target = over?.data.current as DragItem | undefined
  if (!source || !target || (source.kind !== 'tab' && source.kind !== 'saved-item') || (target.kind !== 'saved-item' && target.kind !== 'collection')) return null
  const parentId = target.kind === 'collection' ? target.entityId : doc.entities[target.entityId]?.parentId
  if (parentId !== collectionId) return null
  if (source.kind === 'saved-item' && doc.entities[source.entityId]?.parentId === collectionId) return null
  if (source.kind === 'saved-item' && doc.entities[doc.entities[source.entityId]?.parentId ?? '']?.parentId !== doc.entities[collectionId]?.parentId) return null
  return { beforeId: target.kind === 'saved-item' ? target.entityId : undefined, height: source.kind === 'saved-item' ? active!.rect.current.initial?.height : undefined, target }
}

export function CollectionPlaceholder({ collectionId, target, height }: { collectionId: string; target: DragItem; height?: number }) {
  const { setNodeRef } = useDroppable({ id: `drop-slot:${collectionId}`, data: target })
  return <div ref={setNodeRef} data-motion-id="drop-slot" className="card-placeholder min-h-[104px] rounded-[12px] bg-[#d5e1c680] border-[1.5px] border-dashed border-[#9caf88] animate-placeholder-in" role="img" aria-label="收藏放置位置" style={{ height }} />
}

const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return
  event.preventDefault()
  const { active, collisionRect, droppableContainers, droppableRects } = args.context
  if (!collisionRect) return
  const sourceKind = active?.data.current?.kind
  const sourceTab = sourceKind === 'tab' ? active?.data.current?.tab as OpenTab : undefined
  const savedItemSource = sourceKind === 'saved-item' || sourceKind === 'tab'
  const center = { x: collisionRect.left + collisionRect.width / 2, y: collisionRect.top + collisionRect.height / 2 }
  const inbox = sourceTab ? active?.data.current?.node.current?.closest('.tab-inbox')?.getBoundingClientRect() as DOMRect | undefined : undefined
  const inboxVertical = inbox && center.x >= inbox.left && center.x <= inbox.right && ['ArrowUp', 'ArrowDown'].includes(event.code)
  let distance = Infinity
  let result: { x: number; y: number } | undefined
  for (const container of droppableContainers.getEnabled()) {
    const kind = container.data.current?.kind
    if (sourceTab && kind === 'tab-slot' && (container.data.current?.groupId === sourceTab.groupId || container.data.current?.beforeTabId === sourceTab.tabId)) continue
    if (inboxVertical && !['tab', 'tab-slot', 'tab-group'].includes(kind)) continue
    const tabTarget = sourceTab && ((kind === 'tab' && canSortTabs(sourceTab, container.data.current?.tab)) || kind === 'tab-slot' || kind === 'tab-group')
    if (container.id === active?.id || !(savedItemSource ? tabTarget || ['saved-item', 'collection', 'new-collection'].includes(kind) : sourceKind === 'tab-group' ? kind === 'tab-group' || kind === 'tab-slot' && container.data.current?.groupId === -1 : kind === sourceKind)) continue
    if (savedItemSource && kind === 'collection' && container.node.current?.querySelector('.link-card')) continue
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
    if (source?.kind === 'tab-group') return target === 'tab-group' || target === 'tab-slot' && item?.kind === 'tab-slot' && item.groupId === -1
    if (source?.kind === 'tab' && item?.kind === 'tab-slot') return source.tab.windowId === item.windowId
    if (source?.kind === 'tab' && item?.kind === 'tab-group') return source.tab.windowId === item.windowId
    if (source?.kind === 'tab' && item?.kind === 'tab') return source.tab.windowId === item.tab.windowId && (item.tab.groupId !== -1 || canSortTabs(source.tab, item.tab))
    if (kind === 'todo' || kind === 'space' || kind === 'collection') return target === kind
    return target === 'saved-item' || target === 'collection' || target === 'content' || target === 'new-collection' || (kind === 'saved-item' && target === 'space')
  })
  const scoped = { ...args, droppableContainers }
  const pointerCoordinates = args.pointerCoordinates ?? ((kind === 'saved-item' || kind === 'tab') ? { x: args.collisionRect.left + args.collisionRect.width / 2, y: args.collisionRect.top + args.collisionRect.height / 2 } : null)
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

export function DragBoard({ doc, tabs, refreshTabs, act, notify, moveTab, children: content }: { doc: Document; tabs: OpenTab[]; refreshTabs: () => void; act: Act; notify: (message: string) => void; moveTab: (source: OpenTab, target: OpenTab) => Promise<boolean>; children: ReactNode }) {
  const selection = useSelection()
  const batch = useRef<{ ids: string[]; tabs: OpenTab[] }>({ ids: [], tabs: [] })
  const [dragging, setDragging] = useState<HTMLElement | null>(null)
  const [projection, setProjection] = useState<TabProjection | null>(null)
  const projectionRef = useRef(projection)
  projectionRef.current = projection
  const slots = useRef<TabSlot[]>([])
  const detectCollision: CollisionDetection = args => {
    if (args.active.data.current?.kind !== 'tab') return collision(args)
    slots.current = args.droppableContainers.flatMap(container => container.data.current?.kind === 'tab-slot' ? [container.data.current as TabSlot] : [])
    return collision({ ...args, droppableContainers: args.droppableContainers.filter(container => container.data.current?.kind !== 'tab' || !projectionRef.current?.slot || !projectionRef.current.tabs.some(tab => tab.tabId === container.data.current?.tab.tabId)), droppableRects: inboxLayoutRects(args.droppableRects, args.droppableContainers) })
  }
  const keyboardCoordinates: KeyboardCoordinateGetter = (event, args) => boardKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableRects: inboxLayoutRects(args.context.droppableRects, args.context.droppableContainers.getEnabled()) } })
  const dragSource = useRef<DragItem | undefined>(undefined)
  const dropTargets = useRef(new Map<string, Promise<HTMLElement | null>>())
  const resolveDrop = useRef<(node: HTMLElement | null) => void>(() => {})
  const dropAnimation: DropAnimation = async args => {
    const destination = dropTargets.current.get(String(args.active.id))
    await animateDrop(args, destination ? await destination : null)
    if (dropTargets.current.get(String(args.active.id)) === destination) dropTargets.current.delete(String(args.active.id))
  }
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates }))
  async function finish({ active, over }: DragEndEvent) {
    setDragging(null)
    const source = dragSource.current
    const target = projectionRef.current?.slot ? projectionRef.current.target : over?.data.current as DragTarget | undefined
    const original = active.data.current?.node.current as HTMLElement | null
    const resolve = resolveDrop.current
    const settle = async (success: boolean, target: DropDestination = { kind: 'existing' }) => {
      setProjection(null)
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const destination = target.kind === 'new-link' ? Array.from(document.querySelectorAll<HTMLElement>(target.collectionId ? `[data-drag-id="${window.CSS.escape(target.collectionId)}"] .card-grid > .link-card` : '.card-grid > .link-card')).find(node => !doc.entities[node.dataset.dragId!]) : document.querySelector<HTMLElement>(`[data-drag-id="${window.CSS.escape(String(active.id))}"]`)
      resolve(success ? destination ?? original : original)
    }
    if (!source || !target || active.id === over?.id || target.kind === 'content') { resolve(original); return }
    if (source.kind === 'tab-group') {
      const members = await chrome.tabs.query({ windowId: source.windowId, groupId: source.groupId })
      let index: number
      if (target.kind === 'tab-slot') index = target.index
      else if (target.kind === 'tab-group') {
        const destination = await chrome.tabs.query({ windowId: target.windowId, groupId: target.groupId })
        const forward = Math.min(...members.map(tab => tab.index)) < Math.min(...destination.map(tab => tab.index))
        index = forward ? Math.max(...destination.map(tab => tab.index)) + 1 : Math.min(...destination.map(tab => tab.index))
      } else { resolve(original); return }
      await moveWholeGroup(source.groupId, source.windowId, index - members.filter(tab => tab.index < index).length)
      await settle(true)
      return
    }
    if (target.kind === 'tab-slot' || target.kind === 'tab-group') {
      if (source.kind !== 'tab') { resolve(original); return }
      const slot = tabDropSlot(source.tab, target)!
      await moveTabsToSlot(batch.current.tabs, slot)
      selection.clear()
      await settle(true)
      return
    }
    if (target.kind === 'tab') {
      if (source.kind !== 'tab') { resolve(original); return }
      if (batch.current.tabs.length === 1 && source.tab.groupId === -1 && target.tab.groupId === -1) {
        const success = canSortTabs(source.tab, target.tab) && await moveTab(source.tab, target.tab)
        if (success) selection.clear()
        await settle(success)
      } else {
        await moveTabsToSlot(batch.current.tabs, tabDropSlot(source.tab, target)!)
        selection.clear()
        await settle(true)
      }
      return
    }
    if (target.kind === 'new-collection') {
      if ((source.kind !== 'saved-item' && source.kind !== 'tab') || (source.kind === 'saved-item' && source.itemKind === 'note' && batch.current.ids.length < 2)) { resolve(original); return }
      if (batch.current.ids.length > 1) {
        const success = source.kind === 'saved-item' ? await act({ type: 'collect-items', ids: batch.current.ids, parentId: target.spaceId, title: '新收藏', beforeId: target.beforeId, placement: 'end' }) : await saveTabsBeforeClosing(batch.current.tabs, selection.pendingClosures, unsaved => act({ type: 'collect-tabs', parentId: target.spaceId, title: '新收藏', beforeId: target.beforeId, placement: 'end', links: unsaved.map(tabLink) }))
        await settle(success, source.kind === 'tab' ? { kind: 'new-link' } : { kind: 'existing' })
        if (success) {
          if (source.kind === 'tab') {
            selection.retain(await closeSavedTabs(batch.current.tabs, selection.pendingClosures, notify))
          } else selection.clear()
        }
        return
      }
      const success = source.kind === 'tab' ? await saveTabsBeforeClosing([source.tab], selection.pendingClosures, unsaved => act({ type: 'create-collection-with-link', parentId: target.spaceId, beforeId: target.beforeId, source: { kind: 'new', link: tabLink(unsaved[0]) } })) : await act({ type: 'create-collection-with-link', parentId: target.spaceId, beforeId: target.beforeId, source: { kind: 'link', id: source.entityId } })
      await settle(success, source.kind === 'tab' ? { kind: 'new-link' } : { kind: 'existing' })
      if (success) {
        if (source.kind === 'tab') {
          selection.retain(await closeSavedTabs([source.tab], selection.pendingClosures, notify))
        } else selection.clear()
      }
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
      const parentId = target.kind === 'collection' ? entity.id : target.kind === 'saved-item' ? entity.parentId : null
      if (parentId) {
        const snapshot = batch.current.tabs.length ? batch.current.tabs : [source.tab]
        const success = await saveTabsBeforeClosing(snapshot, selection.pendingClosures, unsaved => act({ type: 'add-links', parentId, links: unsaved.map(tabLink), beforeId: target.kind === 'saved-item' ? target.entityId : undefined }))
        await settle(success, { kind: 'new-link', collectionId: parentId })
        if (success) {
          selection.retain(await closeSavedTabs(snapshot, selection.pendingClosures, notify))
        }
      }
      else resolve(original)
      return
    }
    const moving = doc.entities[source.entityId]
    if (!moving) { resolve(original); return }
    if (source.kind === 'saved-item' && batch.current.ids.length > 1) {
      const parentId = target.kind === 'collection' ? entity.id : target.kind === 'saved-item' ? entity.parentId : null
      if (!parentId || batch.current.ids.includes(entity.id)) { resolve(original); return }
      const success = await act({ type: 'move-items', ids: batch.current.ids, parentId, beforeId: target.kind === 'saved-item' ? beforeId(children(doc, parentId), source.entityId, target.entityId) : undefined })
      if (success) selection.clear()
      await settle(success)
      return
    }
    if (source.kind === target.kind) {
      const success = await act({ type: 'move', id: moving.id, parentId: entity.parentId, beforeId: beforeId(children(doc, entity.parentId).filter(e => e.kind === moving.kind || (source.kind === 'saved-item' && ['link', 'note'].includes(e.kind))), moving.id, entity.id) })
      if (success && source.kind === 'saved-item') selection.clear()
      await settle(success)
    } else if (source.kind === 'saved-item' && (target.kind === 'collection' || target.kind === 'space')) {
      const success = await act({ type: 'move', id: moving.id, parentId: entity.id })
      if (success) selection.clear()
      await settle(success)
    } else resolve(original)
  }
  return <DndContext sensors={sensors} collisionDetection={detectCollision} onDragStart={({ active }) => {
    const item = active.data.current as DragItem | undefined
    dragSource.current = item?.kind === 'tab' ? { ...item, tab: { ...item.tab } } : item
    const ids = item?.kind === 'tab' ? selection.prepareDrag('tabs', String(item.tab.tabId)) : item?.kind === 'saved-item' ? selection.prepareDrag('saved', item.entityId) : []
    batch.current = { ids, tabs: item?.kind === 'tab' ? ids.map(id => tabs.find(tab => String(tab.tabId) === id) ?? item.tab).map(tab => ({ ...tab })) : [] }
    const node = active.data.current?.node.current as HTMLElement | null
    const snapshot = node ? snapshotElement(node) : null
    const rect = node?.getBoundingClientRect()
    setProjection(item?.kind === 'tab' && rect ? { tabs: batch.current.tabs, height: rect.height, width: rect.width } : null)
    const destination = new Promise<HTMLElement | null>(resolve => { resolveDrop.current = destination => {
      setProjection(null)
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(destination)))
    } })
    dropTargets.current.set(String(active.id), destination)
    setDragging(snapshot)
  }} onDragOver={({ over }) => {
    const source = dragSource.current
    const target = over?.data.current as DragTarget | undefined
    const destination = source?.kind === 'tab' ? tabDropSlot(source.tab, target) : undefined
    const slot = destination && slots.current.filter(slot => slot.windowId === destination.windowId && slot.groupId === destination.groupId && slot.index >= destination.index).sort((a, b) => a.index - b.index)[0]
    setProjection(previous => previous ? { ...previous, slot, target: slot && previous.slot?.groupId === slot.groupId && previous.slot.index === slot.index ? previous.target : target } : previous)
  }} onDragEnd={event => {
    selection.setBusy(true)
    void finish(event).catch(cause => { notify(cause instanceof Error ? cause.message : '移动未完成，请重试'); resolveDrop.current(event.active.data.current?.node.current ?? null) }).finally(() => { selection.setBusy(false); refreshTabs() })
  }} onDragCancel={({ active }) => { resolveDrop.current(active.data.current?.node.current ?? null); setDragging(null) }} accessibility={{ screenReaderInstructions: { draggable: '按空格开始拖动，使用方向键调整位置，再按空格放下，Escape 取消。' } }}>
    <TabProjectionContext.Provider value={projection}>{content}</TabProjectionContext.Provider>
    <DragFeedback element={dragging} source={dragSource.current} doc={doc} dropAnimation={dropAnimation} />
  </DndContext>
}

function DragFeedback({ element, source, doc, dropAnimation }: { element: HTMLElement | null; source?: DragItem; doc: Document; dropAnimation: DropAnimation }) {
  const { over } = useDndContext()
  const target = over?.data.current as DragTarget | undefined
  const tab = source?.kind === 'tab' ? source.tab : undefined
  const card = !!tab && !!target && ['content', 'collection', 'saved-item', 'new-collection'].includes(target.kind)
  const collectionId = target?.kind === 'collection' ? target.entityId : target?.kind === 'saved-item' ? doc.entities[target.entityId]?.parentId ?? undefined : undefined
  return <DragOverlay dropAnimation={dropAnimation} zIndex={50}>{element && <DragPreview element={element} tab={tab} card={card} collectionId={collectionId} />}</DragOverlay>
}
