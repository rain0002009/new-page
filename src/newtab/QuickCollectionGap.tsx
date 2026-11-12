import { useEffect, useState } from 'react'
import { useDndContext, useDroppable, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { tv } from 'tailwind-variants/lite'

export type QuickCollectionTarget = { kind: 'new-collection'; spaceId: string; beforeId?: string; ready: boolean }

const line = tv({
  base: 'absolute inset-x-0 top-1/2 h-[2px] rounded-full transition-[background-color,box-shadow] duration-200',
  variants: { ready: {
    false: 'bg-[#9eb68b66]',
    true: 'bg-[#a4c87b] shadow-[0_0_12px_3px_#a6c47880]',
  } },
})

export default function QuickCollectionGap({ spaceId, beforeId }: { spaceId: string; beforeId?: string }) {
  const [ready, setReady] = useState(false)
  const { active } = useDndContext()
  const accepts = active?.data.current?.kind === 'link' || active?.data.current?.kind === 'tab'
  const { setNodeRef, isOver } = useDroppable({ id: `new-collection:${spaceId}:${beforeId ?? 'end'}`, data: { kind: 'new-collection', spaceId, beforeId, ready } satisfies QuickCollectionTarget })
  useEffect(() => {
    setReady(false)
    if (!isOver || !accepts) return
    const timer = setTimeout(() => setReady(true), 2000)
    return () => clearTimeout(timer)
  }, [isOver, accepts])
  return <div ref={setNodeRef} className="relative h-[24px] shrink-0">
    {isOver && accepts && <div role="status" aria-label="快捷建块位置" className="absolute inset-0 pointer-events-none">
      <div className={line({ ready })} />
      {ready && <span className="absolute right-[12px] top-1/2 -translate-y-1/2 rounded-[6px] px-[8px] py-[2px] bg-[#f6fbea] text-[#5d7648] text-[10px] shadow-[0_0_10px_#a6c47840]">松手新建收藏块</span>}
    </div>}
  </div>
}

export const collectionKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  if (!['link', 'tab'].includes(args.context.active?.data.current?.kind)) return sortableKeyboardCoordinates(event, args)
  if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return
  event.preventDefault()
  const { active, collisionRect, droppableContainers, droppableRects } = args.context
  if (!collisionRect) return
  const center = { x: collisionRect.left + collisionRect.width / 2, y: collisionRect.top + collisionRect.height / 2 }
  let distance = Infinity
  let result: { x: number; y: number } | undefined
  for (const container of droppableContainers.getEnabled()) {
    const kind = container.data.current?.kind
    if (container.id === active?.id || !['link', 'collection', 'new-collection'].includes(kind)) continue
    if (kind === 'collection' && container.node.current?.querySelector('.link-card')) continue
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
