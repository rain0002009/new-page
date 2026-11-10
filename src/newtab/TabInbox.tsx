import { useEffect, useState } from 'react'
import { Layers3, ListPlus, GripVertical, X } from 'lucide-react'
import { safeIcon, type LinkInput } from '../core/model'
import { startDrag } from './drag'
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
export default function TabInbox({ tabs, error, open, close, batch }: { tabs: LinkInput[]; error: string; open: boolean; close: () => void; batch: () => void }) {
  return <aside className={`tab-inbox ${open ? 'inbox-open' : ''}`} aria-label="待选网页"><header><div><span className="eyebrow">OPEN TABS</span><h2>待选网页 <span>{tabs.length}</span></h2></div><div className="inbox-tools"><Button size="icon" aria-label="收藏当前窗口" title="收藏当前窗口" disabled={!tabs.length} onClick={batch}><ListPlus size={19} /></Button><Button size="icon" className="drawer-close" aria-label="关闭待选网页" onClick={close}><X size={18} /></Button></div></header><p className="inbox-hint">拖入收藏块，把此刻留到以后。</p>
    {error ? <p role="status" className="error-inline">{error}</p> : tabs.length ? <div className="inbox-list">{tabs.map((tab, index) => <article key={`${tab.url}-${index}`} aria-label={`待选 ${tab.title}`} className="inbox-tab" draggable onDragStart={event => startDrag(event, { tab })}><SiteIcon url={tab.icon || ''} title={tab.title} /><div><strong>{tab.title}</strong><span title={tab.url}>{tab.url}</span></div><GripVertical size={13} /></article>)}</div> : <div className="inbox-empty"><Layers3 size={32} strokeWidth={1.2} /><p>当前窗口没有可收藏的普通网页</p></div>}
    <div className="inbox-footer"><span className="status-dot synced" />当前窗口 · 普通网页 · 拖入即收藏</div></aside>
}
