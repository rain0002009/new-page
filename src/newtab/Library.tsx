import { Fragment, useState } from 'react'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { Bookmark, ChevronDown, ChevronRight, Edit3, Folder, LocateFixed, Plus, Search, Trash2 } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { active, children, pageLabel, type Collection, type Document, type Entity, type Link } from '../core/model'
import { Button, SiteIcon } from './ui'
import type { Act, EditorState } from './Editor'
import { CollectionPlaceholder, useCollectionPlaceholder, useDragItem } from './drag'
import { linkCard } from './link-card-styles'
import { MotionRegion } from './motion'
import SavedPageLink from './SavedPageLink'

const cardAction = tv({
  base: 'h-[27px] w-[27px] shrink-0 p-0 rounded-[9px] border border-solid border-transparent bg-[#f9fcf3e6] hover:text-action-ghost-hover group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(max-width:650px)]:opacity-100',
  variants: { todo: { true: 'text-[#829466] opacity-100', false: 'text-action-ghost opacity-0' } },
  defaultVariants: { todo: false },
})
const collectionTool = 'h-[26px] w-[25px] shrink-0 p-0 rounded-[9px] border border-solid border-transparent bg-transparent text-[#8c9a7f] hover:bg-action-ghost-surface [@media(max-width:650px)]:w-[20px]'
const collectionStyle = tv({
  slots: {
    base: 'collection relative pt-[4px] pb-[8px] rounded-[16px]',
    header: 'flex items-center justify-between min-h-[42px] mb-[10px] gap-[10px] py-[5px]',
    heading: 'flex items-center min-w-0 gap-0',
    title: 'text-[14px] font-semibold flex items-center gap-[7px] min-w-0 truncate text-[#485b3d] [@media(max-width:650px)]:max-w-[170px]',
    count: 'text-[10px] font-normal text-[#a7ad9e] ml-[3px]',
    tools: 'flex items-center gap-[1px]',
  },
})
const collectionStyles = collectionStyle()
const cardGrid = 'card-grid grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-[13px] [@media(min-width:1700px)]:grid-cols-[repeat(auto-fill,minmax(220px,1fr))] [@media(max-width:1200px)]:grid-cols-[repeat(auto-fill,minmax(175px,1fr))] [@media(max-width:650px)]:grid-cols-1'
const search = tv({
  slots: {
    field: 'shrink-0 flex items-center bg-[#fffffbc4] border border-solid border-[#ffffffd4] rounded-[12px] py-[7px] px-[16px] gap-[11px] text-[#92a27e] shadow-[0_6px_24px_#4c683409]',
    input: 'w-full block m-0 bg-transparent border-0 shadow-none py-[11px] px-0 text-[#414d38] text-[12px] rounded-[8px] transition-[border-color] duration-150 placeholder:text-[#b2baa6] placeholder:text-[11px] focus:outline-none focus:shadow-none',
    shortcut: 'whitespace-nowrap text-[9px] bg-[#f2f5eb] py-[3px] px-[7px] rounded-[4px] text-[#a5af99]',
    count: 'shrink-0 text-[10px] text-[#a5af98] mt-[16px] mb-[24px]',
    results: 'overflow-y-auto min-h-0 pt-[4px] px-[4px] pb-[18px]',
  },
})
const searchStyles = search()
const empty = tv({
  slots: {
    base: 'border border-dashed border-[#baca9e85] rounded-[14px] min-h-[220px] flex flex-col items-center justify-center p-[28px] text-[#a5af98] bg-[#fafcf34d] [@media(max-width:650px)]:p-[18px]',
    art: 'relative grid place-items-center w-[70px] h-[65px] bg-[#eef5e49c] rounded-[19px] rotate-[-6deg] text-[#9eae88]',
    badge: 'absolute bottom-[-2px] right-[-4px] border-[3px] border-solid border-[#f8f8f3] w-[25px] h-[25px] rounded-full grid place-items-center bg-[#dae5cb] text-[#6c8556]',
    title: 'text-[14px] font-medium text-[#6b7d5c] mt-[18px]',
    text: 'text-[11px] text-[#839478] mt-[8px] [@media(max-width:650px)]:text-[9px] [@media(max-width:650px)]:text-center',
  },
})
const emptyStyles = empty()

export function Card({ link, act, edit, location, locate }: { link: Link; act: Act; edit: (state: EditorState) => void; location?: string; locate?: () => void }) {
  const styles = linkCard({ search: !!locate })
  const drag = useDragItem(locate ? `search:${link.id}` : link.id, { kind: 'link', entityId: link.id, title: link.title }, styles.base(), !!locate)
  return <article {...drag} aria-label={`链接 ${link.title}`}>
    <div className={styles.top()}><SiteIcon url={link.icon} title={link.title} /><div className={styles.actions()}>
      <Button tone="custom" size="custom" className={cardAction()} aria-label="编辑链接" onClick={() => edit({ kind: 'edit', entity: link })}><Edit3 size={14} /></Button>
      <Button tone="custom" size="custom" className={cardAction()} aria-label="删除链接" onClick={() => void act({ type: 'delete', id: link.id })}><Trash2 size={14} /></Button>
      <Button tone="custom" size="custom" className={cardAction({ todo: link.todo })} aria-label={link.todo ? '移出 Todo' : '加入 Todo'} aria-pressed={link.todo} onClick={() => void act({ type: 'todo', id: link.id, value: !link.todo })}><Bookmark size={15} fill={link.todo ? 'currentColor' : 'none'} /></Button>
    </div></div>
    <SavedPageLink href={link.url} className={styles.title()}>{link.title}</SavedPageLink>
    <span className={styles.domain()}>{pageLabel(link.url)}</span><p className={styles.note()}>{link.note}</p>
    {(location || locate) && <div className={styles.bottom()}>{location && <span className={styles.location()} title={location}><Folder size={10} />{location}</span>}<div className={styles.secondary()}>
      {locate && <Button size="custom" className="h-[21px] w-[23px] shrink-0 p-0" aria-label="定位收藏" onClick={locate}><LocateFixed size={13} /></Button>}
    </div></div>}
  </article>
}

export function CollectionSection({ collection, doc, act, edit }: { collection: Collection; doc: Document; act: Act; edit: (state: EditorState) => void }) {
  const links = children(doc, collection.id).filter((e): e is Link => e.kind === 'link')
  const drag = useDragItem(collection.id, { kind: 'collection', entityId: collection.id, title: collection.title }, collectionStyles.base())
  const placeholder = useCollectionPlaceholder(doc, collection.id)
  const marker = placeholder && <CollectionPlaceholder collectionId={collection.id} target={placeholder.target} height={placeholder.height} />
  return <section {...drag} aria-label={`收藏块 ${collection.title}`} id={`collection-${collection.id}`}>
    <div className={collectionStyles.header()}><div className={collectionStyles.heading()}>
      <Button size="custom" className="h-[26px] w-[24px] shrink-0 p-0 ml-[-5px]" aria-label={`${collection.collapsed ? '展开' : '折叠'} ${collection.title}`} onClick={() => void act({ type: 'edit', id: collection.id, patch: { collapsed: !collection.collapsed } })}>{collection.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</Button>
      <h2 className={collectionStyles.title()}>{collection.title}<span className={collectionStyles.count()} aria-hidden="true">{links.length}</span></h2>
    </div><div className={collectionStyles.tools()}>
      <Button tone="custom" size="custom" className={collectionTool} aria-label={`重命名 ${collection.title}`} onClick={() => edit({ kind: 'rename', entity: collection })}><Edit3 size={13} /></Button>
      <Button tone="custom" size="custom" className={collectionTool} aria-label={`删除 ${collection.title}`} onClick={() => edit({ kind: 'delete', entity: collection })}><Trash2 size={13} /></Button>
    </div></div>
    <MotionRegion>{(!collection.collapsed || placeholder) && (links.length || placeholder ? <SortableContext items={links.map(link => link.id)} strategy={rectSortingStrategy}>
      <div className={cardGrid}>{links.map(link => <Fragment key={link.id}>{placeholder?.beforeId === link.id && marker}<Card link={link} act={act} edit={edit} /></Fragment>)}{!placeholder?.beforeId && marker}</div>
    </SortableContext> : <div className="min-h-[124px] flex items-center justify-center gap-[16px] px-[18px] py-[20px] border border-dashed border-[#baca9e85] rounded-[15px] bg-[#fafcf34d]">
      <Folder size={32} strokeWidth={1.1} className="shrink-0 text-[#9eae88]" />
      <div><h3 className="text-[13px] font-medium text-[#6b7d5c]">暂无收藏</h3><p className="mt-[6px] text-[11px] text-[#839478]">从右侧拖入网页</p></div>
    </div>)}</MotionRegion>
  </section>
}

export function SearchView({ doc, act, edit, locate }: { doc: Document; act: Act; edit: (state: EditorState) => void; locate: (link: Link) => void }) {
  const [term, setTerm] = useState('')
  const links = active(doc).filter((e): e is Link => e.kind === 'link')
  const result = term.trim() ? links.filter(link => `${link.title}\n${link.url}\n${link.note}`.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) : []
  return <><div className={searchStyles.field()}><Search size={19} /><input className={searchStyles.input()} aria-label="搜索全部收藏" type="search" placeholder="搜索标题、网址或备注…" value={term} onChange={e => setTerm(e.target.value)} autoFocus data-autofocus /><kbd className={searchStyles.shortcut()}>全部空间</kbd></div>
    <p className={searchStyles.count()}>{term ? `找到 ${result.length} 个收藏` : `共 ${links.length} 个收藏`}</p>
    <div className={searchStyles.results()}>{result.length ? <div className={cardGrid}>{result.map(link => <Card key={link.id} link={link} act={act} edit={edit} location={locationName(doc, link)} locate={() => locate(link)} />)}</div> : <Empty icon="search" title={term ? '没有匹配的收藏' : '搜索收藏'} text={term ? '请尝试其他关键词' : ''} />}</div>
  </>
}
export function locationName(doc: Document, entity: Entity) {
  const collection = entity.parentId ? doc.entities[entity.parentId] : null
  const space = collection?.parentId ? doc.entities[collection.parentId] : null
  return [space?.title, collection?.title].filter(Boolean).join(' / ')
}
export function Empty({ icon, title, text, children: content }: { icon: 'collection' | 'todo' | 'search'; title: string; text: string; children?: React.ReactNode }) {
  const Icon = icon === 'todo' ? Bookmark : icon === 'search' ? Search : Folder
  return <div className={emptyStyles.base()}><div className={emptyStyles.art()}><Icon size={35} strokeWidth={1.1} /><span className={emptyStyles.badge()}><Plus size={12} /></span></div><h3 className={emptyStyles.title()}>{title}</h3>{text && <p className={emptyStyles.text()}>{text}</p>}{content}</div>
}
