import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus, Layers3, LoaderCircle, X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { useDndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { pageLabel, safeIcon, savedUrl } from '../core/model'
import { canSortTabs, type OpenTab } from './open-tabs'
import { useDragItem } from './drag'
import { Button, SiteIcon } from './ui'
import { Toast } from '../shared/Toast'
import { useLayoutMotion } from './motion'

const inbox = tv({
  slots: {
    base: 'tab-inbox sticky top-0 z-1 h-[100dvh] min-w-0 flex flex-col border-l border-l-solid border-transparent pt-[35px] px-[22px] pb-[35px] [@media(max-width:1200px)]:pt-[31px] [@media(max-width:1200px)]:px-[17px] [@media(min-width:1000.01px)_and_(max-width:1200px)]:pb-[31px]',
    header: 'flex items-center justify-between',
    title: 'text-[15px] [font-weight:550]',
    count: 'font-normal text-[10px] ml-[5px] text-[#a6b09b]',
    list: 'flex-1 overflow-y-auto pt-[25px] pb-[17px] flex flex-col gap-[9px]',
    empty: 'flex flex-1 items-center justify-center flex-col gap-[12px] text-[#b9c3ad] text-center',
    hint: 'text-[10px] text-[#acb59e]',
    tab: 'inbox-tab relative flex items-center gap-[9px] py-[12px] px-[10px] border border-solid border-[#c7d5b894] bg-[#fffffbc9] shadow-[0_2px_8px_#52673c0a] rounded-[10px] [transition:background_.2s,border-color_.2s] hover:bg-[#fffffbf0] hover:border-[#aabd92] active:cursor-grabbing',
    description: 'min-w-0 flex-1',
    tabTitle: 'block text-[11px] [font-weight:550] truncate',
    url: 'block text-[8px] text-[#a2ac96] truncate mt-[4px]',
  },
  variants: { open: {
    true: { base: 'inbox-open [@media(max-width:1000px)]:fixed [@media(max-width:1000px)]:right-0 [@media(max-width:1000px)]:w-[280px] [@media(max-width:1000px)]:z-20 [@media(max-width:1000px)]:shadow-[-15px_0_50px_#3a4e2522] [@media(max-width:1000px)]:pb-[75px] [@media(max-width:1000px)]:bg-[#f4f8edf2] [@media(max-width:1000px)]:backdrop-blur-[24px]' },
    false: { base: '[@media(max-width:1000px)]:hidden' },
  } },
  defaultVariants: { open: false },
})
const styles = inbox()

export function useWindowTabs() {
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [error, setError] = useState('')
  const [refreshRevision, setRefreshRevision] = useState(0)
  useEffect(() => {
    let disposed = false, revision = 0
    const refresh = async () => {
      const request = ++revision
      try {
        const owner = await chrome.tabs.getCurrent()
        if (owner?.windowId === undefined) return
        const list = await chrome.tabs.query({ windowId: owner.windowId })
        if (disposed || request !== revision) return
        setTabs(list.sort((a, b) => a.index - b.index).flatMap(tab => {
          if (tab.id === undefined || tab.id === owner.id) return []
          const url = tab.pendingUrl || tab.url || ''
          try {
            const address = new URL(savedUrl(url))
            if (address.href.startsWith(chrome.runtime.getURL('')) ||
                (['chrome:', 'edge:'].includes(address.protocol) && address.hostname === 'newtab') ||
                (address.protocol === 'about:' && address.pathname === 'newtab')) return []
            return [{ tabId: tab.id, windowId: tab.windowId, pinned: tab.pinned, index: tab.index, title: tab.title || pageLabel(url), url, icon: safeIcon(tab.favIconUrl || '') }]
          } catch { return [] }
        }))
        setError('')
      } catch { if (!disposed) setError('无法读取窗口标签页，请检查扩展权限后重开页面') }
    }
    const listener = () => { void refresh() }
    const events = [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached]
    events.forEach(event => event.addListener(listener))
    void refresh()
    return () => { disposed = true; events.forEach(event => event.removeListener(listener)) }
  }, [refreshRevision])
  return { tabs, error, refresh: () => setRefreshRevision(value => value + 1) }
}
export default function TabInbox({ tabs, error, open, close, collect, collecting, notify }: { tabs: OpenTab[]; error: string; open: boolean; close: () => void; collect: () => void; collecting: boolean; notify: (message: string) => void }) {
  const list = useRef<HTMLDivElement>(null)
  useLayoutMotion(list, ':scope > [data-drag-id]')
  const { active } = useDndContext()
  const dragged = active?.data.current?.kind === 'tab' ? active.data.current.tab as OpenTab : undefined
  // Keep the source mounted until drop so closing the browser tab mid-drag
  // does not unregister the active item or discard its collected snapshot.
  const visibleTabs = dragged && !tabs.some(tab => tab.tabId === dragged.tabId) ? [...tabs, dragged] : tabs
  return <aside className={inbox({ open }).base()} aria-label="待选网页"><header className={styles.header()}><h2 className={styles.title()}>待选网页 <span className={styles.count()}>{tabs.length}</span></h2><div className="flex items-center gap-[2px]"><Button size="icon" aria-label="一键收藏" title="一键收藏全部待选网页" disabled={!tabs.length || !!error || collecting} aria-busy={collecting} onClick={collect}>{collecting ? <LoaderCircle size={17} className="animate-spin" /> : <BookmarkPlus size={17} />}</Button><Button size="icon" className="[@media(min-width:1000.01px)]:hidden" aria-label="关闭待选网页" onClick={close}><X size={18} /></Button></div></header>
    <Toast message={error} />{!error && (visibleTabs.length ? <SortableContext items={visibleTabs.map(tab => `tab:${tab.tabId}`)} strategy={verticalListSortingStrategy}><div ref={list} className={styles.list()}>{visibleTabs.map(tab => <InboxTab key={tab.tabId} tab={tab} notify={notify} />)}</div></SortableContext> : <div className={styles.empty()}><Layers3 size={32} strokeWidth={1.2} /><p className={styles.hint()}>当前窗口没有可收藏的页面</p></div>)}
  </aside>
}
function InboxTab({ tab, notify }: { tab: OpenTab; notify: (message: string) => void }) {
  const [closing, setClosing] = useState(false)
  const { active, over } = useDndContext()
  const source = active?.data.current?.kind === 'tab' ? active.data.current.tab as OpenTab : undefined
  const inserting = source && source.tabId !== tab.tabId && over?.id === `tab:${tab.tabId}` && canSortTabs(source, tab)
  const drag = useDragItem(`tab:${tab.tabId}`, { kind: 'tab', tab, title: tab.title }, styles.tab())
  async function closeTab() {
    setClosing(true)
    try { await chrome.tabs.remove(tab.tabId) }
    catch (error) { if (!(error instanceof Error && /No tab with id/i.test(error.message))) notify('无法关闭标签页，请重试') }
    finally { setClosing(false) }
  }
  return <article {...drag} aria-label={`待选 ${tab.title}`}><SiteIcon size="small" url={tab.icon || ''} title={tab.title} /><div className={styles.description()}><strong className={styles.tabTitle()}>{tab.title}</strong><span className={styles.url()} title={tab.url}>{tab.url}</span></div><Button size="custom" className="h-[26px] w-[26px] shrink-0 p-0" aria-label={`关闭标签页 ${tab.title}`} title={`关闭标签页 ${tab.title}`} disabled={closing} onKeyDown={event => event.stopPropagation()} onClick={() => void closeTab()}><X size={14} /></Button>{inserting && <span role="img" aria-label="标签页放置位置" className={`pointer-events-none absolute left-0 right-0 h-[2px] rounded-full bg-[#829b65] ${source.index < tab.index ? 'bottom-[-6px]' : 'top-[-6px]'}`} />}</article>
}
