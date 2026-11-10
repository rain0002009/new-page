import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check, Cloud, Edit3, Folder, Layers3, Leaf, LoaderCircle, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import { active, children, type Action, type Collection, type Link } from '../core/model'
import { rpc, syncStatusLabels, type Snapshot } from '../core/protocol'
import ConnectionForm from './ConnectionForm'
import SettingsPanel from './SettingsPanel'
import TabInbox, { useWindowTabs } from './TabInbox'
import { allowDrop, dropAction, startDrag } from './drag'
import Editor, { type EditorState } from './Editor'
import { Card, CollectionSection, Empty, locationName, SearchView } from './Library'
import { Button } from './ui'
import './styles.css'

const stateKey = ['workspace']
export default function NewTabApp() {
  const client = useQueryClient()
  const { data, error } = useQuery({ queryKey: stateKey, queryFn: async () => (await rpc({ type: 'snapshot' })).snapshot!, refetchInterval: 5000 })
  const { tabs, error: tabError } = useWindowTabs()
  const [inboxOpen, setInboxOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState('space')
  const [editor, setEditor] = useState<EditorState | null>(null)
  useEffect(() => {
    const listener = (event: { type: string }) => { if (event.type === 'changed') void client.invalidateQueries({ queryKey: stateKey }) }
    chrome.runtime.onMessage.addListener(listener)
    const online = () => { if (data?.sourceId) void rpc({ type: 'sync', sourceId: data.sourceId }) }
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !document.querySelector('dialog[open]')) { event.preventDefault(); setPage('search') }
    }
    if (data?.sourceId) online()
    window.addEventListener('online', online)
    window.addEventListener('keydown', shortcut)
    return () => { chrome.runtime.onMessage.removeListener(listener); window.removeEventListener('online', online); window.removeEventListener('keydown', shortcut) }
  }, [client, data?.sourceId])
  function receive(state: Snapshot) { client.setQueryData(stateKey, state); setMessage('') }
  async function act(action: Action): Promise<boolean> {
    try { const response = await rpc({ type: 'action', sourceId: data!.sourceId!, action }); if (response.snapshot) receive(response.snapshot); return true }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作失败'); return false }
  }
  const notification = message || (error instanceof Error ? error.message : '')
  if (!data) return <main className="loading-screen"><Leaf size={32} /><p>{notification || '正在打开你的小天地…'}</p>{notification && <Button onClick={() => void client.invalidateQueries({ queryKey: stateKey })}>重试</Button>}</main>
  if (!data.document) return <main className="onboarding"><div className="onboarding-story"><Brand /><div className="onboarding-copy"><span className="eyebrow">A PLACE FOR YOUR GOOD FINDS</span><h1>好页面，<br />慢慢收藏。</h1><p>把灵感、日常和下一次想读的内容，<br />安放在自己的小天地里。</p><div className="intro-tiles"><span><Layers3 size={19} />按空间整理</span><span><Bookmark size={19} />留给稍后</span><span><Cloud size={19} />随处接着用</span></div></div><div className="onboarding-footer">少一点散落，多一点井然。<Leaf size={17} /></div></div><section className="onboarding-panel"><span className="soft-icon"><Folder size={25} /></span><span className="eyebrow">MAKE YOURSELF AT HOME</span><h2>先连接你的收藏库</h2><p className="muted">扫码登录夸克网盘，收藏自动保存到你自己的网盘。</p>{notification && <div role="alert" className="alert">{notification}</div>}<ConnectionForm connected={false} done={receive} onError={setMessage} /></section></main>
  const doc = data.document
  const all = active(doc)
  const spaces = all.filter(e => e.kind === 'space')
  const space = spaces.find(e => e.id === selected) ?? spaces[0]
  const nickname = doc.entities.profile.title
  const collections = space ? children(doc, space.id).filter((e): e is Collection => e.kind === 'collection') : []
  const links = all.filter((e): e is Link => e.kind === 'link')
  const status = syncStatusLabels[data.status]
  function locate(link: Link) {
    const collection = doc.entities[link.parentId!]
    setSelected(collection.parentId!); setPage('space')
    if (collection.kind === 'collection' && collection.collapsed) void act({ type: 'edit', id: collection.id, patch: { collapsed: false } })
    setTimeout(() => document.getElementById(`collection-${collection.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
  }
  return <div className="workbench">
    <aside className="sidebar"><Brand /><div className="profile"><span className="avatar">{nickname.slice(0, 1)}</span><div><strong>{nickname}</strong><span>今天也有新的发现</span></div></div>
      <div className="nav-section"><span className="eyebrow">我的空间</span><Button size="icon" aria-label="新建空间" onClick={() => setEditor({ kind: 'space' })}><Plus size={15} /></Button></div>
      <nav className="spaces" aria-label="空间">{spaces.map(item => <div key={item.id} className="space-row" draggable onDragStart={event => startDrag(event, { entityId: item.id })} onDragOver={allowDrop} onDrop={event => { const action = dropAction(event, doc, null, item.id); if (action) void act(action) }}><button aria-label={item.title} title={item.title} className={`nav-item ${page === 'space' && space?.id === item.id ? 'selected' : ''}`} onClick={() => { setSelected(item.id); setPage('space') }}><span className="space-symbol"><Folder size={17} /></span><span>{item.title}</span>{page === 'space' && space?.id === item.id && <span className="selected-dot" />}</button><div className="space-tools"><Button size="icon" aria-label={`重命名空间 ${item.title}`} onClick={() => setEditor({ kind: 'rename', entity: item })}><Edit3 size={12} /></Button><Button size="icon" aria-label={`删除空间 ${item.title}`} onClick={() => setEditor({ kind: 'delete', entity: item })}><Trash2 size={12} /></Button></div></div>)}</nav>
      <div className="nav-section"><span className="eyebrow">工作台</span></div><nav><button aria-label={`Todo ${links.filter(l => l.todo).length}`} title="Todo" className={`nav-item ${page === 'todo' ? 'selected' : ''}`} onClick={() => setPage('todo')}><Bookmark size={18} /><span>Todo</span><span className="count">{links.filter(l => l.todo).length}</span></button><button aria-label="搜索收藏" title="搜索收藏" className={`nav-item ${page === 'search' ? 'selected' : ''}`} onClick={() => setPage('search')}><Search size={18} /><span>搜索收藏</span><kbd>/</kbd></button></nav>
      <div className="sidebar-bottom"><div className="small-quote"><Leaf size={20} /><p>收藏喜欢的，<br />留白给新的。</p></div><button aria-label="设置" title="设置" className={`nav-item ${page === 'settings' ? 'selected' : ''}`} onClick={() => setPage('settings')}><Settings2 size={18} /><span>设置</span></button><button className="sync-state" onClick={() => setPage('settings')}><span className={`status-dot ${data.status}`} />{status}{data.status === 'syncing' && <LoaderCircle size={13} className="animate-spin" />}</button></div>
    </aside>
    <main className="main-content"><div className="topline"><span>你的收藏，自有章法。</span><span>{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())}</span></div>{notification && <div role="alert" className="alert"><span>{notification}</span><Button size="icon" aria-label="关闭提示" onClick={() => setMessage('')}><X size={16} /></Button></div>}
      <div className="heading-row"><PageHeader eyebrow={page === 'space' ? 'YOUR COLLECTIONS' : page === 'settings' ? 'PREFERENCES' : page.toUpperCase()} title={page === 'space' ? space?.title ?? '我的空间' : page === 'todo' ? '留给稍后' : page === 'settings' ? '设置' : '搜索收藏'} subtitle={page === 'space' ? `${collections.length} 个收藏块 · 把值得停留的页面，放在触手可及的地方。` : page === 'settings' ? '让这个小天地更合你的习惯。' : page === 'todo' ? '不急，一次处理一个喜欢的页面。' : '记得一点，就能找到。'} />{page === 'space' && space && <Button tone="primary" aria-label="新建收藏块" onClick={() => setEditor({ kind: 'collection', parentId: space.id })}><Plus size={15} />新建收藏块</Button>}</div>
      {page === 'space' && <>{collections.map(collection => <CollectionSection key={collection.id} collection={collection} doc={doc} act={act} edit={setEditor} />)}{!collections.length && <Empty icon="collection" title="给这个空间一个开始" text="新建一个收藏块，装下这一刻的灵感。"><Button tone="primary" onClick={() => setEditor({ kind: 'collection', parentId: space.id })}><Plus size={15} />创建收藏块</Button></Empty>}</>}
      {page === 'todo' && (links.some(l => l.todo) ? <div className="card-grid">{links.filter(l => l.todo).map(link => <Card key={link.id} link={link} act={act} edit={setEditor} todoView location={locationName(doc, link)} locate={() => locate(link)} />)}</div> : <Empty icon="todo" title="暂时没有待办" text="在收藏卡片上点亮书签，把想处理的页面留给稍后。" />)}
      {page === 'search' && <SearchView doc={doc} act={act} edit={setEditor} locate={locate} />}
      {page === 'settings' && <SettingsPanel key={data.sourceId} data={{ ...data, document: doc }} act={act} receive={receive} onError={setMessage} />}
      <footer className="main-footer"><span><Check size={12} />改动自动保存</span><span>一点点收集，一点点生长</span></footer>
    </main>
    <Button tone="primary" className="inbox-toggle" aria-label="打开待选网页" onClick={() => setInboxOpen(value => !value)}><Layers3 size={16} />待选网页 {tabs.length}</Button><TabInbox tabs={tabs} error={tabError} open={inboxOpen} close={() => setInboxOpen(false)} batch={() => { if (space) setEditor({ kind: 'batch', parentId: space.id }); else setPage('settings') }} />
    {editor && <Editor key={'entity' in editor ? editor.entity.id : editor.kind} state={editor} doc={doc} act={act} batchLinks={tabs.map(tab => ({ ...tab, icon: tab.icon || '' }))} close={() => setEditor(null)} />}
  </div>
}
function Brand() { return <div className="brand"><span><Leaf size={22} strokeWidth={1.8} /></span><div>拾页<small>PAGE GARDEN</small></div></div> }
function PageHeader({ eyebrow, title, subtitle }: { eyebrow: string; title: string; subtitle: string }) { return <header className="page-header"><span className="eyebrow">{eyebrow}</span><h1>{title}<span className="heading-sprout" aria-hidden="true">✳</span></h1><p>{subtitle}</p></header> }
