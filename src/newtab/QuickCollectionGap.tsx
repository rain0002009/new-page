import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { droppedEpubFiles } from '../core/epub'
import { useSelection } from './Selection'

export type QuickCollectionTarget = { kind: 'new-collection'; spaceId: string; beforeId?: string }

function hasFiles(transfer: DataTransfer | null) {
  return !!transfer && Array.from(transfer.types).includes('Files')
}

export default function QuickCollectionGap({
  spaceId,
  beforeId,
  onDropEpubFiles,
}: {
  spaceId: string
  beforeId?: string
  onDropEpubFiles?: (files: File[]) => void
}) {
  const { active, over } = useDndContext()
  const selection = useSelection()
  const [fileOver, setFileOver] = useState(false)
  const accepts = (active?.data.current?.kind === 'saved-item' && (active.data.current.itemKind === 'link' || selection.source === 'saved' && selection.ids.length > 1)) || active?.data.current?.kind === 'tab'
  const { setNodeRef, isOver } = useDroppable({ id: `new-collection:${spaceId}:${beforeId ?? 'end'}`, data: { kind: 'new-collection', spaceId, beforeId } satisfies QuickCollectionTarget })
  const hintRect = accepts && isOver ? over?.rect : undefined

  return (
    <div
      ref={setNodeRef}
      className="relative h-[24px] shrink-0"
      onDragOver={event => {
        if (!hasFiles(event.dataTransfer)) return
        event.preventDefault()
        setFileOver(true)
      }}
      onDragLeave={() => setFileOver(false)}
      onDrop={event => {
        setFileOver(false)
        const epubs = droppedEpubFiles(event.dataTransfer)
        if (!epubs.length) return
        event.preventDefault()
        event.stopPropagation()
        onDropEpubFiles?.(epubs)
      }}
    >
      {((isOver && accepts) || fileOver) && (
        <div role="status" aria-label="快捷建块位置" className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-x-0 top-1/2 h-[2px] rounded-full bg-[#a4c87b] shadow-[0_0_12px_3px_#a6c47880]" />
        </div>
      )}
      {hintRect && createPortal(
        <span className="fixed z-[60] pointer-events-none -translate-y-1/2 rounded-[6px] px-[8px] py-[2px] bg-[#f6fbea] text-[#5d7648] text-[10px] shadow-[0_0_10px_#a6c47840] animate-placeholder-in" style={{ left: hintRect.left + 12, top: hintRect.top + hintRect.height / 2 }}>
          松手新建收藏块
        </span>,
        document.body,
      )}
    </div>
  )
}
