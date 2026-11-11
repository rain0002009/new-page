import { useEffect, useState } from 'react'
import { Layers3, X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { safeIcon, type LinkInput } from '../core/model'
import { useDragItem } from './drag'
import { Button, SiteIcon } from './ui'
import { feedbackStyles } from './form-styles'

const inbox = tv({
  slots: {
    base: 'tab-inbox sticky top-0 z-1 h-[100dvh] min-w-0 flex flex-col border-l border-l-solid border-transparent pt-[35px] px-[22px] pb-[35px] [@media(max-width:1200px)]:pt-[31px] [@media(max-width:1200px)]:px-[17px] [@media(min-width:1000.01px)_and_(max-width:1200px)]:pb-[31px]',
    header: 'flex items-center justify-between',
    title: 'text-[15px] [font-weight:550]',
    count: 'font-normal text-[10px] ml-[5px] text-[#a6b09b]',
    list: 'flex-1 overflow-y-auto pt-[25px] pb-[17px] flex flex-col gap-[9px]',
    empty: 'flex flex-1 items-center justify-center flex-col gap-[12px] text-[#b9c3ad] text-center',
    hint: 'text-[10px] text-[#acb59e]',
    tab: 'inbox-tab flex items-center gap-[9px] py-[12px] px-[10px] border border-solid border-[#ffffff52] bg-[#fffffa42] rounded-[10px] [transition:background_.2s,border-color_.2s] hover:bg-[#fffffa8a] hover:border-[#c4d3b1] active:cursor-grabbing',
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
  const [tabs, setTabs] = useState<LinkInput[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let disposed = false, revision = 0
    const refresh = async () => {
      const request = ++revision
      try {
        const owner = await chrome.tabs.getCurrent()
        if (owner?.windowId === undefined) return
        const list = await chrome.tabs.query({ windowId: owner.windowId })
        if (disposed || request !== revision) return
        setTabs(list.filter(tab => /^https?:\/\//i.test(tab.url ?? '')).sort((a, b) => a.index - b.index).map(tab => ({ title: tab.title || new URL(tab.url!).hostname, url: tab.url!, icon: safeIcon(tab.favIconUrl || '') })))
        setError('')
      } catch { if (!disposed) setError('无法读取窗口标签页，请检查扩展权限后重开页面') }
    }
    const listener = () => { void refresh() }
    const events = [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached]
    events.forEach(event => event.addListener(listener))
    void refresh()
    return () => { disposed = true; events.forEach(event => event.removeListener(listener)) }
  }, [])
  return { tabs, error }
}
export default function TabInbox({ tabs, error, open, close }: { tabs: LinkInput[]; error: string; open: boolean; close: () => void }) {
  return <aside className={inbox({ open }).base()} aria-label="待选网页"><header className={styles.header()}><h2 className={styles.title()}>待选网页 <span className={styles.count()}>{tabs.length}</span></h2><Button size="icon" className="[@media(min-width:1000.01px)]:hidden" aria-label="关闭待选网页" onClick={close}><X size={18} /></Button></header>
    {error ? <p role="status" className={feedbackStyles.error()}>{error}</p> : tabs.length ? <div className={styles.list()}>{tabs.map((tab, index) => <InboxTab key={`${tab.url}-${index}`} tab={tab} index={index} />)}</div> : <div className={styles.empty()}><Layers3 size={32} strokeWidth={1.2} /><p className={styles.hint()}>当前窗口没有可收藏的普通网页</p></div>}
  </aside>
}
function InboxTab({ tab, index }: { tab: LinkInput; index: number }) {
  const drag = useDragItem(`tab:${index}:${tab.url}`, { kind: 'tab', tab, title: tab.title }, styles.tab())
  return <article {...drag} aria-label={`待选 ${tab.title}`}><SiteIcon size="small" url={tab.icon || ''} title={tab.title} /><div className={styles.description()}><strong className={styles.tabTitle()}>{tab.title}</strong><span className={styles.url()} title={tab.url}>{tab.url}</span></div></article>
}
