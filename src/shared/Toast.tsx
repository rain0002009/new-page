import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { Button } from '../newtab/ui'

type Tone = 'error' | 'success' | 'info'
type Notice = { id: string; message: string; tone: Tone; children?: ReactNode; onClose?: () => void }
type Registry = { add: (notice: Notice) => void; update: (notice: Notice) => void; remove: (id: string) => void }
const registry = createContext<Registry | null>(null)
const noticeStyle = tv({
  base: 'pointer-events-auto flex items-start gap-[12px] w-full p-[14px] border border-solid rounded-[12px] shadow-[0_8px_30px_#303b2c26] text-[12px] [overflow-wrap:anywhere]',
  variants: { tone: {
    error: 'bg-[#fff1e4] text-[#865333] border-[#eed0b5]',
    success: 'bg-[#f0f6e8] text-[#45613b] border-[#cbdcbc]',
    info: 'bg-ui-dialog text-ui-ink border-ui-line',
  } },
})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])
  const [portal] = useState(() => document.createElement('div'))
  const viewport = useRef<HTMLDivElement>(null)
  const value = useMemo<Registry>(() => ({
    add: notice => setNotices(current => [...current.filter(item => item.id !== notice.id), notice]),
    update: notice => setNotices(current => current.map(item => item.id === notice.id ? notice : item)),
    remove: id => setNotices(current => current.filter(item => item.id !== id)),
  }), [])
  useLayoutEffect(() => {
    viewport.current?.setAttribute('popover', 'manual')
    // A popover outside a modal dialog is inert. Keep the portal inside the
    // active dialog, then lift it above that dialog without moving focus.
    const position = () => {
      const dialogs = [...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].filter(dialog => dialog.matches(':modal'))
      const parent = dialogs.at(-1) ?? document.body
      const moved = portal.parentElement !== parent
      if (moved) parent.appendChild(portal)
      const node = viewport.current
      if (!node || !node.firstElementChild?.childElementCount) return
      if (moved && node.matches(':popover-open')) node.hidePopover()
      if (!node.matches(':popover-open')) node.showPopover()
    }
    position()
    const observer = new MutationObserver(position)
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open'] })
    return () => { observer.disconnect(); portal.remove() }
  }, [portal])
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    if (notices.length && !node.matches(':popover-open')) node.showPopover()
    else if (!notices.length && node.matches(':popover-open')) node.hidePopover()
  }, [notices])
  const groups = new Map<string, Notice[]>()
  for (const notice of notices) {
    const key = `${notice.tone}:${notice.message}`
    groups.set(key, [...groups.get(key) ?? [], notice])
  }
  return <registry.Provider value={value}>{children}{createPortal(
    <div ref={viewport} aria-label="通知" className="fixed left-auto top-auto right-[20px] bottom-[20px] m-0 p-0 border-0 bg-transparent overflow-visible w-[min(380px,calc(100vw-32px))] max-h-[calc(100dvh-32px)] pointer-events-none [@media(max-width:650px)]:right-[16px] [@media(max-width:650px)]:bottom-[16px]">
      <div className="flex flex-col gap-[10px] max-h-[calc(100dvh-32px)] overflow-y-auto p-[3px]">{[...groups].map(([key, group]) => {
        const notice = group.find(item => item.children) ?? group[0]
        return <ToastItem key={key} {...notice} dismiss={() => { for (const item of group) { value.remove(item.id); item.onClose?.() } }} />
      })}</div>
    </div>, portal,
  )}</registry.Provider>
}

export function Toast({ message, tone = 'error', onClose, children }: { message: string; tone?: Tone; onClose?: () => void; children?: ReactNode }) {
  const api = useContext(registry)
  if (!api) throw new Error('Toast 需要位于 ToastProvider 中')
  const id = useId()
  const latest = useRef({ message, tone, onClose, children })
  latest.current = { message, tone, onClose, children }
  useLayoutEffect(() => {
    if (!message) return
    api.add({ id, ...latest.current })
    return () => api.remove(id)
  }, [api, id, message, tone])
  useLayoutEffect(() => { api.update({ id, ...latest.current }) }, [api, id, children, onClose])
  return null
}

function ToastItem({ message, tone, children, dismiss }: Notice & { dismiss: () => void }) {
  const remaining = useRef(5000)
  const latest = useRef(dismiss)
  latest.current = dismiss
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const close = useCallback(() => latest.current(), [])
  useLayoutEffect(() => {
    if (hovered || focused || tone === 'error') return
    const started = Date.now()
    const timer = setTimeout(close, remaining.current)
    return () => { clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - started)) }
  }, [hovered, focused, tone, Boolean(children), close])
  return <div role={tone === 'error' ? 'alert' : 'status'} aria-atomic="true" className={noticeStyle({ tone })}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false) }}>
    <div className="min-w-0 flex-1"><p className="m-0 [line-height:1.6]">{message}</p>{children && <div className="flex flex-wrap items-center gap-[8px] mt-[8px]">{children}</div>}</div>
    <Button size="icon" className="-mt-[4px] -mr-[4px]" aria-label="关闭提示" onClick={close}><X size={16} /></Button>
  </div>
}
