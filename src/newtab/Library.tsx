import { useState } from 'react'
import { ArrowUpRight, Bookmark, Check, ChevronDown, ChevronRight, Edit3, Folder, GripVertical, LocateFixed, Move, Plus, Search, Trash2 } from 'lucide-react'
import { active, children, type Collection, type Document, type Entity, type Link } from '../core/model'
import { Button, SiteIcon } from './ui'
import type { Act, EditorState } from './Editor'
import { allowDrop, dropAction, startDrag } from './drag'

export function Card({ link, act, edit, todoView = false, location, locate, doc }: { link: Link; act: Act; edit: (state: EditorState) => void; todoView?: boolean; location?: string; locate?: () => void; doc?: Document }) {
  return <article className="link-card" aria-label={`链接 ${link.title}`} draggable onDragStart={event => startDrag(event, { entityId: link.id })} onDragOver={doc ? allowDrop : undefined} onDrop={doc ? event => { const action = dropAction(event, doc, link.parentId, link.id); if (action) void act(action) } : undefined}>
    <div className="card-top"><SiteIcon url={link.icon} title={link.title} /><div className="card-actions"><Button size="icon" aria-label="编辑链接" onClick={() => edit({ kind: 'edit', entity: link })}><Edit3 size={14} /></Button><Button size="icon" aria-label="删除链接" onClick={() => edit({ kind: 'delete', entity: link })}><Trash2 size={14} /></Button><Button size="icon" className={link.todo ? 'todo-lit' : ''} aria-label={todoView ? '完成待办' : link.todo ? '移出 Todo' : '加入 Todo'} aria-pressed={link.todo} onClick={() => void act({ type: 'todo', id: link.id, value: !link.todo })}>{todoView ? <Check size={15} /> : <Bookmark size={15} fill={link.todo ? 'currentColor' : 'none'} />}</Button></div><ArrowUpRight size={15} className="open-arrow" /></div>
    <a href={link.url} target="_blank" rel="noreferrer" className="link-title">{link.title}</a><span className="link-domain">{new URL(link.url).hostname}</span><p className="link-note">{link.note || '还没有备注'}</p>
    <div className="card-bottom">{location && <span className="location-label" title={location}><Folder size={10} />{location}</span>}<div className="card-secondary">{locate && <Button size="icon" aria-label="定位收藏" onClick={locate}><LocateFixed size={13} /></Button>}<Button size="icon" aria-label="移动链接" onClick={() => edit({ kind: 'move', entity: link })}><Move size={13} /></Button></div></div>
  </article>
}
export function CollectionSection({ collection, doc, act, edit }: { collection: Collection; doc: Document; act: Act; edit: (state: EditorState) => void }) {
  const links = children(doc, collection.id).filter((e): e is Link => e.kind === 'link')
  return <section className="collection" aria-label={`收藏块 ${collection.title}`} id={`collection-${collection.id}`} onDragOver={allowDrop} onDrop={event => { const action = dropAction(event, doc, collection.id); if (action) void act(action) }}>
    <div className="collection-header"><div className="collection-heading"><Button size="icon" aria-label={`${collection.collapsed ? '展开' : '折叠'} ${collection.title}`} onClick={() => void act({ type: 'edit', id: collection.id, patch: { collapsed: !collection.collapsed } })}>{collection.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</Button><h2>{collection.title}<span aria-hidden="true">{links.length}</span></h2></div><div className="collection-tools"><Button size="icon" aria-label={`重命名 ${collection.title}`} onClick={() => edit({ kind: 'rename', entity: collection })}><Edit3 size={13} /></Button><Button size="icon" aria-label={`删除 ${collection.title}`} onClick={() => edit({ kind: 'delete', entity: collection })}><Trash2 size={13} /></Button><Button aria-label="添加链接" onClick={() => edit({ kind: 'add', parentId: collection.id })}><Plus size={14} />添加链接</Button></div></div>
    <div className="collection-order" draggable onDragStart={event => startDrag(event, { entityId: collection.id })} onDragOver={allowDrop} onDrop={event => { const action = dropAction(event, doc, collection.parentId, collection.id); if (action) void act(action) }} aria-label={`拖动排序 ${collection.title}`} title="拖动调整收藏块顺序"><GripVertical size={13} /></div>
    {!collection.collapsed && <>{links.length ? <div className="card-grid">{links.map(link => <Card key={link.id} link={link} act={act} edit={edit} doc={doc} />)}</div> : <Empty icon="collection" title="把好页面，留在这里" text="从右侧拖入网页，或添加你的第一个链接"><Button tone="primary" onClick={() => edit({ kind: 'add', parentId: collection.id })}><Plus size={16} />添加第一个链接</Button></Empty>}</>}
  </section>
}
export function SearchView({ doc, act, edit, locate }: { doc: Document; act: Act; edit: (state: EditorState) => void; locate: (link: Link) => void }) {
  const [term, setTerm] = useState('')
  const links = active(doc).filter((e): e is Link => e.kind === 'link')
  const result = term.trim() ? links.filter(link => `${link.title}\n${link.url}\n${link.note}`.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) : []
  return <><div className="search-field"><Search size={19} /><input aria-label="搜索全部收藏" type="search" placeholder="搜索标题、网址或备注…" value={term} onChange={e => setTerm(e.target.value)} autoFocus /><kbd>全部空间</kbd></div><p className="result-count">{term ? `找到 ${result.length} 个收藏` : `在 ${links.length} 个收藏里，找回你的灵感`}</p>{result.length ? <div className="card-grid">{result.map(link => <Card key={link.id} link={link} act={act} edit={edit} location={locationName(doc, link)} locate={() => locate(link)} />)}</div> : <Empty icon="search" title={term ? '还没有找到' : '记得一点，就能找到'} text={term ? '换个关键词试试，也许就在下一次搜索里。' : '所有空间里的标题、网址和备注，都可以搜索。'} />}</>
}
export function locationName(doc: Document, entity: Entity) {
  const collection = entity.parentId ? doc.entities[entity.parentId] : null
  const space = collection?.parentId ? doc.entities[collection.parentId] : null
  return [space?.title, collection?.title].filter(Boolean).join(' / ')
}
export function Empty({ icon, title, text, children: content }: { icon: 'collection' | 'todo' | 'search'; title: string; text: string; children?: React.ReactNode }) {
  const Icon = icon === 'todo' ? Bookmark : icon === 'search' ? Search : Folder
  return <div className="collection-empty"><div className="empty-art"><Icon size={35} strokeWidth={1.1} /><span><Plus size={12} /></span></div><h3>{title}</h3><p>{text}</p>{content}</div>
}
