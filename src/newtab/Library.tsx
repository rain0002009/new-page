import { Fragment, useState } from 'react'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { Bookmark, ChevronDown, ChevronRight, Edit3, Folder, LocateFixed, Plus, Search, Trash2 } from 'lucide-react'
import { active, children, type Collection, type Document, type Entity, type Link } from '../core/model'
import { Button, SiteIcon } from './ui'
import type { Act, EditorState } from './Editor'
import { CollectionPlaceholder, useCollectionPlaceholder, useDragItem } from './drag'

export function Card({ link, act, edit, location, locate }: { link: Link; act: Act; edit: (state: EditorState) => void; location?: string; locate?: () => void }) {
  const drag = useDragItem(locate ? `search:${link.id}` : link.id, { kind: 'link', entityId: link.id, title: link.title }, !!locate)
  return <article {...drag} className="link-card" aria-label={`链接 ${link.title}`}>
    <div className="card-top"><SiteIcon url={link.icon} title={link.title} /><div className="card-actions">
      <Button size="icon" aria-label="编辑链接" onClick={() => edit({ kind: 'edit', entity: link })}><Edit3 size={14} /></Button>
      <Button size="icon" aria-label="删除链接" onClick={() => void act({ type: 'delete', id: link.id })}><Trash2 size={14} /></Button>
      <Button size="icon" className={link.todo ? 'todo-lit' : ''} aria-label={link.todo ? '移出 Todo' : '加入 Todo'} aria-pressed={link.todo} onClick={() => void act({ type: 'todo', id: link.id, value: !link.todo })}><Bookmark size={15} fill={link.todo ? 'currentColor' : 'none'} /></Button>
    </div></div>
    <a href={link.url} target="_blank" rel="noreferrer" draggable={false} className="link-title">{link.title}</a>
    <span className="link-domain">{new URL(link.url).hostname}</span><p className="link-note">{link.note}</p>
    {(location || locate) && <div className="card-bottom">{location && <span className="location-label" title={location}><Folder size={10} />{location}</span>}<div className="card-secondary">
      {locate && <Button size="icon" aria-label="定位收藏" onClick={locate}><LocateFixed size={13} /></Button>}
    </div></div>}
  </article>
}

export function CollectionSection({ collection, doc, act, edit }: { collection: Collection; doc: Document; act: Act; edit: (state: EditorState) => void }) {
  const links = children(doc, collection.id).filter((e): e is Link => e.kind === 'link')
  const drag = useDragItem(collection.id, { kind: 'collection', entityId: collection.id, title: collection.title })
  const placeholder = useCollectionPlaceholder(doc, collection.id)
  const marker = placeholder && <CollectionPlaceholder collectionId={collection.id} target={placeholder.target} height={placeholder.height} />
  return <section {...drag} className="collection" aria-label={`收藏块 ${collection.title}`} id={`collection-${collection.id}`}>
    <div className="collection-header"><div className="collection-heading">
      <Button size="icon" aria-label={`${collection.collapsed ? '展开' : '折叠'} ${collection.title}`} onClick={() => void act({ type: 'edit', id: collection.id, patch: { collapsed: !collection.collapsed } })}>{collection.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</Button>
      <h2>{collection.title}<span aria-hidden="true">{links.length}</span></h2>
    </div><div className="collection-tools">
      <Button size="icon" aria-label={`重命名 ${collection.title}`} onClick={() => edit({ kind: 'rename', entity: collection })}><Edit3 size={13} /></Button>
      <Button size="icon" aria-label={`删除 ${collection.title}`} onClick={() => edit({ kind: 'delete', entity: collection })}><Trash2 size={13} /></Button>
    </div></div>
    {(!collection.collapsed || placeholder) && (links.length || placeholder ? <SortableContext items={links.map(link => link.id)} strategy={rectSortingStrategy}>
      <div className="card-grid">{links.map(link => <Fragment key={link.id}>{placeholder?.beforeId === link.id && marker}<Card link={link} act={act} edit={edit} /></Fragment>)}{!placeholder?.beforeId && marker}</div>
    </SortableContext> : <Empty icon="collection" title="暂无收藏" text="从右侧拖入网页" />)}
  </section>
}

export function SearchView({ doc, act, edit, locate }: { doc: Document; act: Act; edit: (state: EditorState) => void; locate: (link: Link) => void }) {
  const [term, setTerm] = useState('')
  const links = active(doc).filter((e): e is Link => e.kind === 'link')
  const result = term.trim() ? links.filter(link => `${link.title}\n${link.url}\n${link.note}`.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) : []
  return <><div className="search-field"><Search size={19} /><input aria-label="搜索全部收藏" type="search" placeholder="搜索标题、网址或备注…" value={term} onChange={e => setTerm(e.target.value)} autoFocus data-autofocus /><kbd>全部空间</kbd></div>
    <p className="result-count">{term ? `找到 ${result.length} 个收藏` : `共 ${links.length} 个收藏`}</p>
    <div className="search-results">{result.length ? <div className="card-grid">{result.map(link => <Card key={link.id} link={link} act={act} edit={edit} location={locationName(doc, link)} locate={() => locate(link)} />)}</div> : <Empty icon="search" title={term ? '没有匹配的收藏' : '搜索收藏'} text={term ? '请尝试其他关键词' : ''} />}</div>
  </>
}
export function locationName(doc: Document, entity: Entity) {
  const collection = entity.parentId ? doc.entities[entity.parentId] : null
  const space = collection?.parentId ? doc.entities[collection.parentId] : null
  return [space?.title, collection?.title].filter(Boolean).join(' / ')
}
export function Empty({ icon, title, text, children: content }: { icon: 'collection' | 'todo' | 'search'; title: string; text: string; children?: React.ReactNode }) {
  const Icon = icon === 'todo' ? Bookmark : icon === 'search' ? Search : Folder
  return <div className="collection-empty"><div className="empty-art"><Icon size={35} strokeWidth={1.1} /><span><Plus size={12} /></span></div><h3>{title}</h3>{text && <p>{text}</p>}{content}</div>
}
