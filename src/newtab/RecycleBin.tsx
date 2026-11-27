import { useEffect, useRef, useState } from 'react'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { RotateCcw, Trash2 } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { active, type Document, type Entity } from '../core/model'
import type { Act } from './Editor'
import { Button, Modal, ModalPresence } from './ui'

const styles = tv({
  slots: {
    button: 'relative ml-[8px] mb-[9px] block h-[138px] w-[136px] border-0 bg-transparent p-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ui-focus [@media(max-width:650px)]:mx-auto [@media(max-width:650px)]:w-[51px] [@media(max-width:650px)]:h-[68px]',
    object: 'block h-[130px] w-[124px] transition-transform duration-200 hover:translate-y-[-3px] [@media(max-width:650px)]:h-[62px] [@media(max-width:650px)]:w-[51px]',
    row: 'flex items-center justify-between gap-[12px] py-[15px] border-t border-t-solid border-ui-line [@media(max-width:650px)]:flex-wrap',
    meta: 'block mt-[4px] text-[9px] text-[#a4ad97]',
  },
  variants: { over: { true: { object: 'translate-y-[-6px] scale-[1.08]' } } },
})

function WastepaperBasket({ full, highlighted }: { full: boolean; highlighted: boolean }) {
  const outline = highlighted ? '#648557' : '#809a8d'
  return <svg viewBox="0 0 120 130" className="h-full w-full overflow-visible [filter:drop-shadow(0_8px_7px_#546d5830)]" aria-hidden="true">
    <defs>
      <pattern id="basket-mesh" width="13" height="13" patternUnits="userSpaceOnUse"><path d="M0 0 13 13M13 0 0 13" fill="none" stroke="#8da99a" strokeWidth="1" opacity=".65" /></pattern>
    </defs>
    {full && <g strokeLinejoin="round" strokeWidth="1.7">
      <path d="m27 31 2-19 11-3 7 8 11-4 6 16-8 16-21-1Z" fill="#f3e6c9" stroke="#b6a382" />
      <path d="m56 32 9-23 11 3 9-5 8 19-10 18-22-1Z" fill="#dcebe9" stroke="#8da8a5" />
      <path d="m35 17 9 7-4 9m27-13 11 8-8 9" fill="none" stroke="#b1b9a9" opacity=".8" />
    </g>}
    <path d="M13 40 27 110c2 10 64 10 66 0l14-70Z" fill={highlighted ? '#d7e9cc' : '#e5eee6'} fillOpacity=".86" />
    <path d="M13 40 27 110c2 10 64 10 66 0l14-70Z" fill="url(#basket-mesh)" />
    <path d="M13 40 27 110c2 10 64 10 66 0l14-70" fill="none" stroke={outline} strokeWidth="2.5" strokeLinejoin="round" />
    <ellipse cx="60" cy="39" rx="48" ry="10" fill={highlighted ? '#c8dfbd' : '#d5e3d7'} stroke={outline} strokeWidth="2.5" />
    <ellipse cx="60" cy="37" rx="40" ry="5" fill="#a9bfb0" fillOpacity=".3" />
    <path d="M22 43 31 107M97 43 89 107" fill="none" stroke="#ffffff" strokeOpacity=".65" strokeWidth="2" />
  </svg>
}

export default function RecycleBin({ doc, act }: { doc: Document; act: Act }) {
  const [open, setOpen] = useState(false)
  const [action, setAction] = useState<{ type: 'purge'; entity: Entity } | { type: 'empty-trash' } | null>(null)
  const [busy, setBusy] = useState(false)
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (clickTimer.current) clearTimeout(clickTimer.current) }, [])
  const deleted = Object.values(doc.entities).filter(entity => !entity.purged && entity.deletedAt !== null && entity.deletedBy === entity.id).sort((a, b) => b.deletedAt! - a.deletedAt!)
  const { active: dragging } = useDndContext()
  const kind = dragging?.data.current?.kind
  const accepts = kind === 'space' ? active(doc).filter(entity => entity.kind === 'space').length > 1 : ['collection', 'saved-item', 'todo', 'tab'].includes(kind)
  const { setNodeRef, isOver } = useDroppable({ id: 'recycle-bin', data: { kind: 'trash' }, disabled: !!dragging && !accepts })
  const visual = styles({ over: accepts && isOver })

  async function confirm() {
    if (!action || busy) return
    setBusy(true)
    const success = await act(action.type === 'purge' ? { type: 'purge', id: action.entity.id } : { type: 'empty-trash' })
    if (success) setAction(null)
    setBusy(false)
  }
  async function restore(id: string) {
    if (busy) return
    setBusy(true)
    try { await act({ type: 'restore', id }) }
    finally { setBusy(false) }
  }

  return <>
    <button ref={setNodeRef} data-drop-bin type="button" aria-label="回收站" title="回收站：单击查看，双击清空" className={visual.button()} onClick={event => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
      if (event.detail > 1) return
      if (event.detail === 0) setOpen(true)
      else clickTimer.current = setTimeout(() => { clickTimer.current = null; setOpen(true) }, 320)
    }} onDoubleClick={() => {
      if (clickTimer.current) clearTimeout(clickTimer.current)
      clickTimer.current = null
      if (deleted.length && !busy) setAction({ type: 'empty-trash' })
    }}>
      <span className={visual.object()} aria-hidden="true"><WastepaperBasket full={deleted.length > 0} highlighted={accepts && isOver} /></span>
    </button>
    <ModalPresence>{open && <Modal title="回收站" close={() => { if (!busy && !action) setOpen(false) }}>
      <div className="mb-[15px] flex items-start justify-between gap-[12px]"><p className="text-[11px] text-ui-muted">保留 30 天。恢复父级时会一并恢复随它删除的内容和待办标记。</p><Button tone="danger" aria-label="清空回收站" disabled={busy || !deleted.length} onClick={() => setAction({ type: 'empty-trash' })}><Trash2 size={14} />清空</Button></div>
      {deleted.length ? <div>{deleted.map(entity => <div key={entity.id} className={visual.row()}>
        <div className="min-w-0 [overflow-wrap:anywhere]"><strong className="text-[12px] [font-weight:550]">{entity.title}</strong><span className={visual.meta()}>{entity.kind === 'space' ? '空间' : entity.kind === 'collection' ? '收藏块' : entity.kind === 'note' ? '笔记' : entity.kind === 'book' ? '电子书' : '链接'} · {Math.max(1, Math.ceil((30 * 86400_000 - Date.now() + entity.deletedAt!) / 86400_000))} 天后清理</span></div>
        <div className="flex shrink-0 items-center gap-[8px]"><Button aria-label={`恢复 ${entity.title}`} disabled={busy} onClick={() => void restore(entity.id)}><RotateCcw size={14} />恢复</Button><Button tone="danger" aria-label={`彻底删除 ${entity.title}`} disabled={busy} onClick={() => setAction({ type: 'purge', entity })}><Trash2 size={14} />删除</Button></div>
      </div>)}</div> : <p className="p-[25px] text-center text-[11px] text-[#acb59f]">回收站空空的</p>}
    </Modal>}</ModalPresence>
    <ModalPresence>{action && <Modal title={action.type === 'purge' ? '彻底删除' : '清空回收站'} close={() => { if (!busy) setAction(null) }}>
      <p className="text-[14px] [overflow-wrap:anywhere]">{action.type === 'purge' ? `彻底删除「${action.entity.title}」及其包含的内容？` : '彻底删除回收站中的全部内容？'}</p>
      <p className="mt-[12px] text-[11px] text-ui-muted">删除后无法从回收站恢复。</p>
      <div className="mt-[24px] flex justify-end gap-[8px]"><Button data-autofocus disabled={busy} onClick={() => setAction(null)}>取消</Button><Button tone="danger" disabled={busy} onClick={() => void confirm()}>{action.type === 'purge' ? '删除' : '清空'}</Button></div>
    </Modal>}</ModalPresence>
  </>
}
