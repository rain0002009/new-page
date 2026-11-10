import { useEffect, useState } from 'react'
import { Layers3, X } from 'lucide-react'
import { safeIcon, type LinkInput } from '../core/model'
import { useDragItem } from './drag'
import { Button, SiteIcon } from './ui'

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
  return <aside className={`tab-inbox ${open ? 'inbox-open' : ''}`} aria-label="待选网页"><header><h2>待选网页 <span>{tabs.length}</span></h2><Button size="icon" className="drawer-close" aria-label="关闭待选网页" onClick={close}><X size={18} /></Button></header>
    {error ? <p role="status" className="error-inline">{error}</p> : tabs.length ? <div className="inbox-list">{tabs.map((tab, index) => <InboxTab key={`${tab.url}-${index}`} tab={tab} index={index} />)}</div> : <div className="inbox-empty"><Layers3 size={32} strokeWidth={1.2} /><p>当前窗口没有可收藏的普通网页</p></div>}
  </aside>
}
function InboxTab({ tab, index }: { tab: LinkInput; index: number }) {
  const drag = useDragItem(`tab:${index}:${tab.url}`, { kind: 'tab', tab, title: tab.title })
  return <article {...drag} aria-label={`待选 ${tab.title}`} className="inbox-tab"><SiteIcon url={tab.icon || ''} title={tab.title} /><div><strong>{tab.title}</strong><span title={tab.url}>{tab.url}</span></div></article>
}
