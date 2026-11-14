import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Square } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import type { OpenTab } from './open-tabs'

type Source = 'tabs' | 'saved'
type Selection = { source: Source | null; ids: string[]; anchor?: string }
type SelectionContext = Selection & {
  busy: boolean
  setBusy: (busy: boolean) => void
  toggle: (source: Source, id: string, range?: boolean) => void
  clear: () => void
  retain: (ids: string[]) => void
  selectAll: () => void
  isSelected: (source: Source, id: string) => boolean
  prepareDrag: (source: Source, id: string) => string[]
  pendingClosures: Map<number, OpenTab>
}
const context = createContext<SelectionContext | null>(null)
const empty: Selection = { source: null, ids: [] }

export function SelectionProvider({ scope, orders, pendingClosures, externalBusy = false, children }: { scope: string; orders: Record<Source, string[]>; pendingClosures: Map<number, OpenTab>; externalBusy?: boolean; children: ReactNode }) {
  const [selection, setSelection] = useState<Selection>(empty)
  const [operationBusy, setBusy] = useState(false)
  const busy = operationBusy || externalBusy
  const current = useRef(selection)
  current.current = selection
  const scopeRef = useRef(scope)
  useEffect(() => {
    if (scopeRef.current !== scope) { scopeRef.current = scope; setSelection(empty); return }
    setSelection(previous => {
      if (!previous.source) return previous
      const ids = orders[previous.source].filter(id => previous.ids.includes(id))
      return ids.length === previous.ids.length && ids.every((id, index) => id === previous.ids[index]) ? previous : ids.length ? { ...previous, ids } : empty
    })
  }, [scope, orders.tabs.join('\0'), orders.saved.join('\0')])
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy && !document.querySelector('dialog[open], [data-group-editor]') && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) setSelection(empty)
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [busy])
  const clear = () => setSelection(empty)
  const value: SelectionContext = {
    ...selection, busy, setBusy, pendingClosures, clear,
    isSelected: (source, id) => selection.source === source && selection.ids.includes(id),
    toggle: (source, id, range) => {
      if (busy || !orders[source].includes(id)) return
      setSelection(previous => {
        const selected = previous.source === source ? previous.ids : []
        const anchor = previous.source === source ? previous.anchor : undefined
        const start = anchor ? orders[source].indexOf(anchor) : -1
        const end = orders[source].indexOf(id)
        const added = range && start >= 0 ? orders[source].slice(Math.min(start, end), Math.max(start, end) + 1) : [id]
        const next = !range && selected.includes(id) ? selected.filter(item => item !== id) : [...new Set([...selected, ...added])]
        return next.length ? { source, ids: orders[source].filter(item => next.includes(item)), anchor: range && anchor ? anchor : id } : empty
      })
    },
    retain: ids => setSelection(previous => previous.source && ids.length ? { ...previous, ids: orders[previous.source].filter(id => ids.includes(id)) } : empty),
    selectAll: () => { if (!busy && selection.source) setSelection({ source: selection.source, ids: [...orders[selection.source]], anchor: orders[selection.source][0] }) },
    prepareDrag: (source, id) => {
      const previous = current.current
      if (previous.source === source && previous.ids.includes(id)) return orders[source].filter(item => previous.ids.includes(item))
      setSelection(empty)
      return [id]
    },
  }
  return <context.Provider value={value}>{children}</context.Provider>
}

export function useSelection() {
  const selection = useContext(context)
  if (!selection) throw new Error('批量选择必须位于工作台内')
  return selection
}

const icon = tv({
  base: 'group/selection relative z-3 grid shrink-0 place-items-center rounded-[8px] border-0 p-0 bg-transparent cursor-pointer focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ui-focus disabled:cursor-default',
  variants: { small: { true: 'h-[28px] w-[28px]', false: 'h-[30px] w-[30px]' } },
  defaultVariants: { small: false },
})
export function SelectionIcon({ id, source, title, children, small = false }: { id: string; source: Source; title: string; children: ReactNode; small?: boolean }) {
  const selection = useSelection()
  const checked = selection.isSelected(source, id)
  const selecting = selection.source === source && selection.ids.length > 0
  return <button type="button" role="checkbox" aria-label={`选择 ${title}`} aria-checked={checked} title={`选择 ${title}`} disabled={selection.busy} className={icon({ small })}
    onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }}
    onClick={event => { event.stopPropagation(); selection.toggle(source, id, event.shiftKey) }}>
    <span className={selecting ? 'invisible' : 'group-hover/selection:invisible group-focus-visible/selection:invisible [@media(hover:none)]:invisible'}>{children}</span>
    <span className={`absolute inset-0 grid place-items-center rounded-[7px] text-[#627e4d] ${selecting ? 'opacity-100' : 'opacity-0 group-hover/selection:opacity-100 group-focus-visible/selection:opacity-100 [@media(hover:none)]:opacity-100'}`}>
      {checked ? <span className="grid h-[20px] w-[20px] place-items-center rounded-[4px] bg-[#6c8755] text-white"><Check size={15} /></span> : <Square size={22} />}
    </span>
  </button>
}
