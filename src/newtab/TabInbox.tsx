import { Fragment, useEffect, useRef, useState, type FormEvent } from 'react'
import { BookmarkPlus, ChevronDown, ChevronRight, Edit3, Group, Layers3, LoaderCircle, Ungroup, X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { useDndContext, useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { pageLabel, safeIcon, savedUrl } from '../core/model'
import { canSortTabs, type OpenTab } from './open-tabs'
import type { TabSlot, WindowTabGroup } from './tab-groups'
import { useDragItem } from './drag'
import { SelectionIcon, useSelection } from './Selection'
import { Button, SiteIcon } from './ui'
import { Toast } from '../shared/Toast'
import { useLayoutMotion } from './motion'

const inbox = tv({
  slots: {
    base: 'tab-inbox sticky top-0 z-1 h-[100dvh] min-w-0 flex flex-col border-l border-l-solid border-transparent pt-[35px] px-[22px] pb-[35px] [@media(max-width:1200px)]:pt-[31px] [@media(max-width:1200px)]:px-[17px] [@media(min-width:1000.01px)_and_(max-width:1200px)]:pb-[31px]',
    header: 'flex items-center justify-between',
    title: 'text-[15px] [font-weight:550]',
    count: 'font-normal text-[10px] ml-[5px] text-[#a6b09b]',
    list: 'flex-1 overflow-y-auto pt-[25px] pb-[17px] flex flex-col',
    empty: 'flex flex-1 items-center justify-center flex-col gap-[12px] text-[#b9c3ad] text-center',
    hint: 'text-[10px] text-[#acb59e]',
    tab: 'inbox-tab group/inbox-tab relative flex items-center gap-[9px] py-[12px] px-[10px] border border-solid border-[#c7d5b894] bg-[#fffffbc9] shadow-[0_2px_8px_#52673c0a] rounded-[10px] [transition:background_.2s,border-color_.2s] hover:bg-[#fffffbf0] hover:border-[#aabd92] active:cursor-grabbing text-ui-ink',
    description: 'min-w-0 flex-1',
    tabTitle: 'block w-full border-0 bg-transparent p-0 text-left text-[11px] [font-weight:550] truncate cursor-pointer hover:underline focus-visible:outline-2 focus-visible:outline-ui-focus',
    url: 'block text-[8px] text-[#a2ac96] truncate mt-[4px]',
  },
  variants: { open: {
    true: { base: 'inbox-open [@media(max-width:1000px)]:fixed [@media(max-width:1000px)]:right-0 [@media(max-width:1000px)]:w-[280px] [@media(max-width:1000px)]:z-20 [@media(max-width:1000px)]:shadow-[-15px_0_50px_#3a4e2522] [@media(max-width:1000px)]:pb-[75px] [@media(max-width:1000px)]:bg-[#f4f8edf2] [@media(max-width:1000px)]:backdrop-blur-[24px]' },
    false: { base: '[@media(max-width:1000px)]:hidden' },
  } },
  defaultVariants: { open: false },
})
const styles = inbox()
const groupColor = tv({
  base: 'tab-group relative rounded-[10px] border-l-[3px] border-l-solid pl-[7px] pr-[5px] py-[3px] min-w-0',
  variants: { color: {
    grey: 'border-l-[#89929e] bg-[#89929e0c] text-[#67717f]',
    blue: 'border-l-[#598beb] bg-[#598beb0c] text-[#366bc8]',
    red: 'border-l-[#df6d67] bg-[#df6d670c] text-[#b64b45]',
    yellow: 'border-l-[#d6ad39] bg-[#d6ad390c] text-[#98771b]',
    green: 'border-l-[#5fa875] bg-[#5fa8750c] text-[#3f8553]',
    pink: 'border-l-[#d780b5] bg-[#d780b50c] text-[#ac5c8d]',
    purple: 'border-l-[#a081d5] bg-[#a081d50c] text-[#7e59b6]',
    cyan: 'border-l-[#56a6b4] bg-[#56a6b40c] text-[#347e8b]',
    orange: 'border-l-[#d79351] bg-[#d793510c] text-[#a86b2e]',
  } },
})
const groupColors = [
  { color: 'grey', label: '灰色', swatch: 'bg-[#89929e]' },
  { color: 'blue', label: '蓝色', swatch: 'bg-[#598beb]' },
  { color: 'red', label: '红色', swatch: 'bg-[#df6d67]' },
  { color: 'yellow', label: '黄色', swatch: 'bg-[#d6ad39]' },
  { color: 'green', label: '绿色', swatch: 'bg-[#5fa875]' },
  { color: 'pink', label: '粉色', swatch: 'bg-[#d780b5]' },
  { color: 'purple', label: '紫色', swatch: 'bg-[#a081d5]' },
  { color: 'cyan', label: '青色', swatch: 'bg-[#56a6b4]' },
  { color: 'orange', label: '橙色', swatch: 'bg-[#d79351]' },
] as const
const groupButton = tv({
  base: 'shrink-0 p-0 rounded-[7px] border-0 bg-transparent text-current hover:bg-[#ffffff90]',
  variants: { collapse: { true: 'h-[25px] w-[20px]', false: 'h-[26px] w-[23px]' } },
  defaultVariants: { collapse: false },
})

export function useWindowTabs() {
  const [tabs, setTabs] = useState<OpenTab[]>([])
  const [groups, setGroups] = useState<WindowTabGroup[]>([])
  const [windowId, setWindowId] = useState<number>()
  const [error, setError] = useState('')
  const [refreshRevision, setRefreshRevision] = useState(0)
  useEffect(() => {
    let disposed = false, revision = 0
    const refresh = async () => {
      const request = ++revision
      try {
        const owner = await chrome.tabs.getCurrent()
        if (owner?.windowId === undefined) return
        const [list, nativeGroups] = await Promise.all([chrome.tabs.query({ windowId: owner.windowId }), chrome.tabGroups.query({ windowId: owner.windowId })])
        if (disposed || request !== revision) return
        setWindowId(owner.windowId)
        const ordered = list.sort((a, b) => a.index - b.index)
        setTabs(ordered.flatMap(tab => {
          if (tab.id === undefined || tab.id === owner.id) return []
          const url = tab.pendingUrl || tab.url || ''
          try {
            const address = new URL(savedUrl(url))
            if (address.href.startsWith(chrome.runtime.getURL('')) ||
                (['chrome:', 'edge:'].includes(address.protocol) && address.hostname === 'newtab') ||
                (address.protocol === 'about:' && address.pathname === 'newtab')) return []
            return [{ tabId: tab.id, windowId: tab.windowId, pinned: tab.pinned, index: tab.index, groupId: tab.groupId, title: tab.title || pageLabel(url), url, icon: safeIcon(tab.favIconUrl || '') }]
          } catch { return [] }
        }))
        setGroups(nativeGroups.map(group => {
          const members = ordered.filter(tab => tab.groupId === group.id)
          return { ...group, memberCount: members.length, firstIndex: members[0]?.index ?? 0, lastIndex: members.at(-1)?.index ?? 0 }
        }).sort((a, b) => a.firstIndex - b.firstIndex))
        setError('')
      } catch { if (!disposed) setError('无法读取窗口标签页，请检查扩展权限后重开页面') }
    }
    const listener = () => { void refresh() }
    const events = [chrome.tabs.onCreated, chrome.tabs.onRemoved, chrome.tabs.onUpdated, chrome.tabs.onMoved, chrome.tabs.onAttached, chrome.tabs.onDetached, chrome.tabGroups.onCreated, chrome.tabGroups.onUpdated, chrome.tabGroups.onMoved, chrome.tabGroups.onRemoved]
    events.forEach(event => event.addListener(listener))
    void refresh()
    return () => { disposed = true; events.forEach(event => event.removeListener(listener)) }
  }, [refreshRevision])
  return { tabs, groups, windowId, error, refresh: () => setRefreshRevision(value => value + 1) }
}

export default function TabInbox({ tabs, groups = [], error, open, close, collect, collecting, groupAll, grouping, notify }: {
  tabs: OpenTab[]; groups?: WindowTabGroup[]; error: string; open: boolean; close: () => void; collect: () => void; collecting: boolean; groupAll: () => void; grouping: boolean; notify: (message: string) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const selection = useSelection()
  useLayoutMotion(list, ':scope > [data-motion-id]')
  const { active } = useDndContext()
  const dragged = active?.data.current?.kind === 'tab' ? active.data.current.tab as OpenTab : undefined
  // Retain the active source while Chrome emits changes during a drop.
  const visibleTabs = dragged && !tabs.some(tab => tab.tabId === dragged.tabId) ? [...tabs, dragged] : tabs
  const groupIds = new Set(groups.map(group => group.id))
  const entries = [
    ...visibleTabs.filter(tab => !groupIds.has(tab.groupId)).map(tab => ({ kind: 'tab' as const, index: tab.index, tab })),
    ...groups.map(group => ({ kind: 'group' as const, index: group.firstIndex, group })),
  ].sort((a, b) => a.index - b.index)
  return <aside className={inbox({ open }).base()} aria-label="待选网页"><header className={styles.header()}><h2 className={styles.title()}>待选网页 <span className={styles.count()}>{tabs.length}</span></h2><div className="flex items-center gap-[2px]">
    <Button size="icon" aria-label="一键收藏" title="一键收藏全部待选网页" disabled={!tabs.length || !!error || collecting || grouping || selection.busy} aria-busy={collecting} onClick={collect}>{collecting ? <LoaderCircle size={17} className="animate-spin" /> : <BookmarkPlus size={17} />}</Button>
    <Button size="icon" aria-label="一键分组" title="将全部待选网页放入新分组" disabled={!tabs.length || !!error || collecting || grouping || selection.busy} aria-busy={grouping} onClick={groupAll}>{grouping ? <LoaderCircle size={17} className="animate-spin" /> : <Group size={17} />}</Button>
    <Button size="icon" className="[@media(min-width:1000.01px)]:hidden" aria-label="关闭待选网页" onClick={close}><X size={18} /></Button></div></header>
    <Toast message={error} />{!error && (entries.length ? <SortableContext items={entries.map(entry => entry.kind === 'group' ? `tab-group:${entry.group.id}` : `tab:${entry.tab.tabId}`)} strategy={verticalListSortingStrategy}><div ref={list} className={styles.list()}>{entries.map(entry => <Fragment key={entry.kind === 'group' ? `group:${entry.group.id}` : `tab:${entry.tab.tabId}`}>
      <TabDropSlot slot={{ windowId: entry.kind === 'group' ? entry.group.windowId : entry.tab.windowId, groupId: -1, index: entry.index, beforeTabId: entry.kind === 'tab' ? entry.tab.tabId : undefined }} />
      {entry.kind === 'group' ? <InboxGroup group={entry.group} tabs={visibleTabs.filter(tab => tab.groupId === entry.group.id)} notify={notify} /> : <InboxTab tab={entry.tab} notify={notify} />}
    </Fragment>)}<TabDropSlot slot={{ windowId: entries[0].kind === 'group' ? entries[0].group.windowId : entries[0].tab.windowId, groupId: -1, index: Math.max(...entries.map(entry => entry.kind === 'group' ? entry.group.lastIndex : entry.tab.index)) + 1 }} /></div></SortableContext> : <div className={styles.empty()}><Layers3 size={32} strokeWidth={1.2} /><p className={styles.hint()}>当前窗口没有可收藏的页面</p></div>)}
  </aside>
}

function TabDropSlot({ slot, title }: { slot: TabSlot; title?: string }) {
  const { active } = useDndContext()
  const { setNodeRef, isOver } = useDroppable({ id: `tab-slot:${slot.groupId}:${slot.index}`, data: { kind: 'tab-slot', ...slot } })
  const accepts = active?.data.current?.kind === 'tab' || (slot.groupId === -1 && active?.data.current?.kind === 'tab-group')
  return <div ref={setNodeRef} className="relative h-[8px] shrink-0" data-tab-slot={slot.groupId}>
    {accepts && isOver && <span role="status" aria-label="标签页放置位置" className="pointer-events-none absolute z-5 inset-x-0 top-1/2 h-[2px] rounded-full bg-[#829b65]"><span className="absolute right-0 bottom-[4px] max-w-full truncate rounded-[4px] bg-ui-dialog px-[5px] text-[9px] text-ui-ink shadow-sm">{slot.groupId === -1 ? '移出分组' : `加入${title || '分组'}`}</span></span>}
  </div>
}

function InboxGroup({ group, tabs, notify }: { group: WindowTabGroup; tabs: OpenTab[]; notify: (message: string) => void }) {
  const name = group.title || '未命名分组'
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const selection = useSelection()
  const drag = useDragItem(`tab-group:${group.id}`, { kind: 'tab-group', groupId: group.id, windowId: group.windowId, title: name }, 'flex min-w-0 items-center gap-[2px] py-[5px] text-[11px]')
  async function change(run: () => Promise<unknown>) {
    setBusy(true)
    try { await run() } catch { notify('无法修改分组，请重试') } finally { setBusy(false) }
  }
  return <div role="group" aria-label={`标签组 ${name}`} className={groupColor({ color: group.color })} data-motion-id={`tab-group:${group.id}`}>
    <div {...drag}>
      <Button tone="custom" size="custom" className={groupButton({ collapse: true })} aria-label={`${group.collapsed ? '展开' : '折叠'}分组 ${name}`} aria-expanded={!group.collapsed} disabled={busy || selection?.busy} onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation() }} onClick={() => void change(() => chrome.tabGroups.update(group.id, { collapsed: !group.collapsed }))}>{group.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</Button>
      <span className="h-[7px] w-[7px] shrink-0 rounded-full bg-current" aria-hidden="true" /><strong className="min-w-0 flex-1 truncate ml-[4px] font-medium" title={name}>{name}</strong><span className="text-[9px] opacity-70 mr-[2px]">{group.memberCount}</span>
      <Button tone="custom" size="custom" className={groupButton()} aria-label={`编辑分组 ${name}`} title={`编辑分组 ${name}`} disabled={busy || selection?.busy} onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation() }} onClick={() => setEditing(value => !value)}><Edit3 size={12} /></Button>
      <Button tone="custom" size="custom" className={groupButton()} aria-label={`解除分组 ${name}`} title={`解除分组 ${name}`} disabled={busy || selection?.busy} onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation() }} onClick={() => void change(async () => {
        const members = await chrome.tabs.query({ windowId: group.windowId, groupId: group.id })
        if (members.length) await chrome.tabs.ungroup([members[0].id!, ...members.slice(1).map(tab => tab.id!)])
      })}><Ungroup size={13} /></Button>
    </div>
    {editing && <GroupEditor group={group} close={() => setEditing(false)} />}
    {!group.collapsed && <SortableContext items={tabs.map(tab => `tab:${tab.tabId}`)} strategy={verticalListSortingStrategy}>{tabs.map(tab => <Fragment key={tab.tabId}><TabDropSlot slot={{ windowId: group.windowId, groupId: group.id, index: tab.index, beforeTabId: tab.tabId }} title={name} /><InboxTab tab={tab} notify={notify} /></Fragment>)}<TabDropSlot slot={{ windowId: group.windowId, groupId: group.id, index: group.lastIndex + 1 }} title={name} /></SortableContext>}
    {group.collapsed && <TabDropSlot slot={{ windowId: group.windowId, groupId: group.id, index: group.lastIndex + 1 }} title={name} />}
  </div>
}

function GroupEditor({ group, close }: { group: WindowTabGroup; close: () => void }) {
  const root = useRef<HTMLFormElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(group.title || '')
  const [color, setColor] = useState(group.color)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  useEffect(() => {
    input.current?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !savingRef.current) close() }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [close])
  async function save(event?: FormEvent) {
    event?.preventDefault()
    if (savingRef.current) return
    if (!title.trim()) { setError('请输入分组名称'); input.current?.focus(); return }
    savingRef.current = true; setSaving(true); setError('')
    try { await chrome.tabGroups.update(group.id, { title: title.trim(), color }); close() }
    catch { setError('分组保存失败，请重试') }
    finally { savingRef.current = false; setSaving(false) }
  }
  return <form ref={root} role="dialog" data-group-editor aria-label={`编辑分组 ${group.title || '未命名分组'}`} className="absolute top-[38px] right-0 z-30 w-[min(250px,100%)] rounded-[12px] border border-solid border-white bg-ui-dialog p-[13px] shadow-[0_12px_40px_#334c2b30] text-ui-ink" onSubmit={event => void save(event)} onMouseDown={event => event.stopPropagation()} onTouchStart={event => event.stopPropagation()} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !saving) { event.preventDefault(); close() } }}>
    <label className="block text-[11px]">分组名称<input ref={input} aria-label="分组名称" maxLength={1000} className="mt-[7px] box-border w-full rounded-[7px] border border-solid border-[#c7d5b8] bg-white px-[9px] py-[7px] text-[12px] text-ui-ink" value={title} onChange={event => { setTitle(event.target.value); setError('') }} disabled={saving} /></label>
    <div role="group" aria-label="分组颜色" className="mt-[12px] grid grid-cols-9 gap-[3px]">{groupColors.map(option => <Button key={option.color} tone="custom" size="custom" aria-label={option.label} aria-pressed={color === option.color} title={option.label} disabled={saving} onClick={() => setColor(option.color)} className={`aspect-square w-full max-w-[21px] rounded-full border-[2px] border-solid ${color === option.color ? 'border-ui-ink ring-2 ring-white' : 'border-transparent'} ${option.swatch}`} />)}</div>
    {error && <p role="alert" className="mt-[8px] text-[10px] text-action-danger">{error}</p>}
    <div className="mt-[12px] flex justify-end gap-[5px]"><Button size="custom" className="px-[8px] py-[5px] text-[11px]" disabled={saving} onClick={close}>取消</Button><Button tone="primary" size="custom" className="px-[9px] py-[5px] text-[11px]" disabled={saving} aria-busy={saving} onClick={() => void save()}>保存分组</Button></div>
  </form>
}

function InboxTab({ tab, notify }: { tab: OpenTab; notify: (message: string) => void }) {
  const [closing, setClosing] = useState(false)
  const { active, over } = useDndContext()
  const selection = useSelection()
  const source = active?.data.current?.kind === 'tab' ? active.data.current.tab as OpenTab : undefined
  const inserting = source && source.tabId !== tab.tabId && over?.id === `tab:${tab.tabId}` && canSortTabs(source, tab)
  const drag = useDragItem(`tab:${tab.tabId}`, { kind: 'tab', tab, title: tab.title }, styles.tab())
  async function closeTab() {
    setClosing(true)
    try { await chrome.tabs.remove(tab.tabId) }
    catch (error) { if (!(error instanceof Error && /No tab with id/i.test(error.message))) notify('无法关闭标签页，请重试') }
    finally { setClosing(false) }
  }
  return <article {...drag} aria-label={`待选 ${tab.title}`} data-selected={selection?.isSelected('tabs', String(tab.tabId)) || undefined}>
    <SelectionIcon source="tabs" id={String(tab.tabId)} title={tab.title} small><SiteIcon size="small" url={tab.icon || ''} title={tab.title} /></SelectionIcon>
    <div className={styles.description()}><button type="button" className={styles.tabTitle()} onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation() }} onClick={() => { if (!active) void chrome.tabs.update(tab.tabId, { active: true }).catch(() => notify('无法打开标签页，请重试')) }}>{tab.title}</button><span className={styles.url()} title={tab.url}>{tab.url}</span></div>
    <Button size="custom" className="h-[26px] w-[26px] shrink-0 p-0" aria-label={`关闭标签页 ${tab.title}`} title={`关闭标签页 ${tab.title}`} disabled={closing || selection?.busy} onKeyDown={event => { if (event.code === 'Space' || event.code === 'Enter') event.stopPropagation() }} onClick={() => void closeTab()}><X size={14} /></Button>
    {inserting && <span role="img" aria-label="标签页放置位置" className={`pointer-events-none absolute left-0 right-0 h-[2px] rounded-full bg-[#829b65] ${source.index < tab.index ? 'bottom-[-6px]' : 'top-[-6px]'}`} />}
  </article>
}
