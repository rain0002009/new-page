import { useEffect, useState } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Edit3, Folder, Layers3, Leaf, LoaderCircle, Plus, Search, Settings2, Trash2, X } from 'lucide-react'
import { active, children, type Action, type Collection, type Entity, type Link } from '../core/model'
import { rpc, syncStatusLabels, type Snapshot } from '../core/protocol'
import ConnectionForm from './ConnectionForm'
import SettingsPanel from './SettingsPanel'
import TabInbox, { useWindowTabs } from './TabInbox'
import { DragBoard, useDragItem } from './drag'
import TodoList from './TodoList'
import FluidBackground from './FluidBackground'
import ContentPanel from './ContentPanel'
import Editor, { type EditorState } from './Editor'
import { CollectionSection, Empty, SearchView } from './Library'
import { Button, Modal } from './ui'
import './styles.css'

export const stateKey = ['workspace']
export default function NewTabApp() {
  return <><FluidBackground /><Workbench /></>
}
function Workbench() {
  const client = useQueryClient()
  const { data, error } = useQuery({ queryKey: stateKey, queryFn: async () => (await rpc({ type: 'snapshot' })).snapshot!, refetchInterval: 5000 })
  const { tabs, error: tabError } = useWindowTabs()
  const [inboxOpen, setInboxOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState('space')
  const [searchOpen, setSearchOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  useEffect(() => {
    const listener = (event: { type: string }) => { if (event.type === 'changed') void client.invalidateQueries({ queryKey: stateKey }) }
    chrome.runtime.onMessage.addListener(listener)
    const online = () => { if (data?.sourceId) void rpc({ type: 'sync', sourceId: data.sourceId }) }
    const shortcut = (event: KeyboardEvent) => {
      if (event.key === '/' && !(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement) && !document.querySelector('dialog[open]')) { event.preventDefault(); setSearchOpen(true) }
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
  if (!data) return <main className="loading-screen"><Leaf size={32} /><p>{notification || '正在加载…'}</p>{notification && <Button onClick={() => void client.invalidateQueries({ queryKey: stateKey })}>重试</Button>}</main>
  if (!data.document) return <main className="onboarding"><section className="onboarding-panel"><Brand /><h1>连接收藏库</h1>{notification && <div role="alert" className="alert">{notification}</div>}<ConnectionForm connected={false} done={receive} onError={setMessage} /></section></main>
  const doc = data.document
  const all = active(doc)
  const spaces = all.filter(e => e.kind === 'space')
  const space = spaces.find(e => e.id === selected) ?? spaces[0]
  const nickname = doc.entities.profile.title
  const collections = space ? children(doc, space.id).filter((e): e is Collection => e.kind === 'collection') : []
  const links = all.filter((e): e is Link => e.kind === 'link')
  const status = syncStatusLabels[data.status]
  function locate(link: Link) {
    setSearchOpen(false)
    const collection = doc.entities[link.parentId!]
    setSelected(collection.parentId!); setPage('space')
    if (collection.kind === 'collection' && collection.collapsed) void act({ type: 'edit', id: collection.id, patch: { collapsed: false } })
    setTimeout(() => document.getElementById(`collection-${collection.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
  }
  return <DragBoard doc={doc} act={act}><div className="workbench" onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    <aside className="sidebar"><Brand /><div className="profile"><span className="avatar">{nickname.slice(0, 1)}</span><strong>{nickname}</strong></div>
      <div className="nav-section"><span className="eyebrow">我的空间</span><Button size="icon" aria-label="新建空间" onClick={() => setEditor({ kind: 'space' })}><Plus size={15} /></Button></div>
      <SortableContext items={spaces.map(item => item.id)} strategy={verticalListSortingStrategy}><nav className="spaces" aria-label="空间">{spaces.map(item => <SpaceRow key={item.id} item={item} selected={page === 'space' && space?.id === item.id} select={() => { setSelected(item.id); setPage('space') }} rename={() => setEditor({ kind: 'rename', entity: item })} remove={() => setEditor({ kind: 'delete', entity: item })} />)}</nav></SortableContext>
      <div className="nav-section"><span className="eyebrow">工作台</span></div><nav>
        <button aria-label={`Todo ${links.filter(l => l.todo).length}`} title="Todo" className={`nav-item ${page === 'todo' ? 'selected' : ''}`} onClick={() => setPage('todo')}><Bookmark size={18} /><span>Todo</span><span className="count">{links.filter(l => l.todo).length}</span></button>
        <button aria-label="搜索收藏" title="搜索收藏" className={`nav-item ${searchOpen ? 'selected' : ''}`} onClick={() => setSearchOpen(true)}><Search size={18} /><span>搜索收藏</span><kbd>/</kbd></button>
      </nav>
      <div className="sidebar-bottom"><button aria-label="设置" title="设置" className={`nav-item ${page === 'settings' ? 'selected' : ''}`} onClick={() => setPage('settings')}><Settings2 size={18} /><span>设置</span></button><button className="sync-state" onClick={() => setPage('settings')}><span className={`status-dot ${data.status}`} />{status}{data.status === 'syncing' && <LoaderCircle size={13} className="animate-spin" />}</button></div>
    </aside>
    <ContentPanel scrollKey={`${page}:${space?.id ?? ''}`} header={<>
      {notification && <div role="alert" className="alert"><span>{notification}</span><Button size="icon" aria-label="关闭提示" onClick={() => setMessage('')}><X size={16} /></Button></div>}
      <div className="heading-row"><header className="page-header"><h1>{page === 'space' ? space?.title ?? '我的空间' : page === 'todo' ? 'Todo' : page === 'settings' ? '设置' : '搜索收藏'}</h1></header>{page === 'space' && space && <Button tone="primary" aria-label="新建收藏块" onClick={() => setEditor({ kind: 'collection', parentId: space.id })}><Plus size={15} />新建收藏块</Button>}</div>
    </>}>
      {page === 'space' && <SortableContext items={collections.map(c => c.id)} strategy={verticalListSortingStrategy}>{collections.map(collection => <CollectionSection key={collection.id} collection={collection} doc={doc} act={act} edit={setEditor} />)}{!collections.length && <Empty icon="collection" title="暂无收藏块" text=""><Button tone="primary" onClick={() => setEditor({ kind: 'collection', parentId: space.id })}><Plus size={15} />创建收藏块</Button></Empty>}</SortableContext>}
      {page === 'todo' && <TodoList doc={doc} act={act} />}
      {page === 'settings' && <SettingsPanel key={data.sourceId} data={{ ...data, document: doc }} act={act} receive={receive} onError={setMessage} />}
    </ContentPanel>
    <Button tone="primary" className="inbox-toggle" aria-label="打开待选网页" onClick={() => setInboxOpen(value => !value)}><Layers3 size={16} />待选网页 {tabs.length}</Button><TabInbox tabs={tabs} error={tabError} open={inboxOpen} close={() => setInboxOpen(false)} />
    {searchOpen && <Modal title="搜索收藏" close={() => setSearchOpen(false)} wide className="search-modal"><SearchView doc={doc} act={act} edit={setEditor} locate={locate} /></Modal>}
    {editor && <Editor key={'entity' in editor ? editor.entity.id : editor.kind} state={editor} doc={doc} act={act} close={() => setEditor(null)} />}
  </div></DragBoard>
}
function Brand() { return <div className="brand"><span><Leaf size={22} strokeWidth={1.8} /></span><div>拾页<small>PAGE GARDEN</small></div></div> }
function SpaceRow({ item, selected, select, rename, remove }: { item: Entity; selected: boolean; select: () => void; rename: () => void; remove: () => void }) {
  const drag = useDragItem(item.id, { kind: 'space', entityId: item.id, title: item.title })
  return <div {...drag} className="space-row"><button aria-label={item.title} title={item.title} className={`nav-item ${selected ? 'selected' : ''}`} onClick={select}><span className="space-symbol"><Folder size={17} /></span><span>{item.title}</span>{selected && <span className="selected-dot" />}</button><div className="space-tools"><Button size="icon" aria-label={`重命名空间 ${item.title}`} onClick={rename}><Edit3 size={12} /></Button><Button size="icon" aria-label={`删除空间 ${item.title}`} onClick={remove}><Trash2 size={12} /></Button></div></div>
}
