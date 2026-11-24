import { Fragment, useEffect, useRef, useState } from 'react'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import { ArrowUpDown, Bookmark, Check, ChevronDown, ChevronRight, Edit3, FilePlus2, FileText, Folder, LocateFixed, Pencil, Plus, Search, Share2, Trash2, X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { active, children, type Collection, type Document, type Entity, type Link, type Note, type SavedItem, type ShareRecord } from '../core/model'
import { documentUrl, markdownDescription } from '../core/markdown'
import { useInlineTitleEdit } from './useInlineTitleEdit'
import { readLocalSnapshot } from '../core/local-workspace'
import { Button, ModalPresence, SiteIcon, Tooltip } from './ui'
import type { Act, EditorState } from './Editor'
import { CollectionPlaceholder, useCollectionPlaceholder, useDragItem } from './drag'
import { linkCard } from './link-card-styles'
import { MotionRegion } from './motion'
import SavedPageLink from './SavedPageLink'
import { Toast } from '../shared/Toast'
import { SelectionIcon, useSelection } from './Selection'
import { OpenCollectionModal } from './OpenCollectionModal'
import { openCollection } from './tab-manager'

const cardAction = tv({
  base: 'h-[27px] w-[27px] shrink-0 p-0 rounded-[9px] border border-solid border-transparent bg-[#f9fcf3e6] group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(max-width:650px)]:opacity-100',
  variants: { tone: { regular: 'text-action-ghost hover:text-action-ghost-hover opacity-0', todo: 'text-[#829466] hover:text-action-ghost-hover opacity-100', share: 'text-[#587346] hover:text-action-ghost-hover opacity-100 bg-[#edf3e2]', danger: 'text-action-danger hover:bg-action-danger-hover opacity-0' } },
  defaultVariants: { tone: 'regular' },
})
const collectionTool = 'h-[32px] w-[32px] shrink-0 p-0 rounded-[6px] border border-solid border-transparent bg-transparent text-[#8c9a7f] hover:bg-action-ghost-surface [@media(max-width:650px)]:w-[20px]'
const collectionStyle = tv({
  slots: {
    base: 'collection relative pt-[4px] pb-[8px] rounded-[16px]',
    header: 'flex items-center justify-between min-h-[42px] mb-[10px] gap-[10px] py-[5px]',
    heading: 'flex items-center min-w-0 gap-0',
    title: 'text-[16px] font-semibold flex items-center gap-[7px] min-w-0 truncate text-[#485b3d] [@media(max-width:650px)]:max-w-[170px]',
    count: 'text-[10px] font-normal text-[#a7ad9e] ml-[3px]',
    tools: 'flex items-center gap-[1px]',
  },
})
const collectionStyles = collectionStyle()
const cardGrid = 'card-grid grid gap-3 grid-cols-[repeat(auto-fill,minmax(clamp(175px,17vw,190px),1fr))]'
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
  const selection = useSelection()
  const styles = linkCard({ search: !!locate })
  const drag = useDragItem(locate ? `search:${link.id}` : link.id, { kind: 'saved-item', itemKind: 'link', entityId: link.id, title: link.title }, styles.base(), !!locate)
  return <article {...drag} data-selected={!locate && selection.isSelected('saved', link.id) || undefined} aria-label={`链接 ${link.title}`}>
    <div className={styles.top()}><span className={styles.icon()}>{locate ? <SiteIcon size="card" url={link.icon} title={link.title} /> : <SelectionIcon size="card" id={link.id} source="saved" title={link.title}><SiteIcon size="card" url={link.icon} title={link.title} /></SelectionIcon>}</span><SavedPageLink href={link.url} className={styles.title()}>{link.title}</SavedPageLink></div>
    <div className={styles.actions()}>
      <Tooltip content="编辑链接">
        <Button tone="custom" size="custom" className={cardAction()} aria-label="编辑链接" onClick={() => edit({ kind: 'edit', entity: link })}><Edit3 size={14} /></Button>
      </Tooltip>
      <Button tone="custom" size="custom" className={cardAction({ tone: 'danger' })} aria-label="删除链接" onClick={() => void act({ type: 'delete', id: link.id })}><Trash2 size={14} /></Button>
      <Tooltip content={link.todo ? '移出待办' : '加入待办'}>
        <Button tone="custom" size="custom" className={cardAction({ tone: link.todo ? 'todo' : 'regular' })} aria-label={link.todo ? '移出待办' : '加入待办'} aria-pressed={link.todo} onClick={() => void act({ type: 'todo', id: link.id, value: !link.todo })}><Bookmark size={15} fill={link.todo ? 'currentColor' : 'none'} /></Button>
      </Tooltip>
    </div>
    <p className={styles.note()}>{link.note}</p>
    {(location || locate) && <div className={styles.bottom()}>{location && <span className={styles.location()} title={location}><Folder size={10} />{location}</span>}<div className={styles.secondary()}>
      {locate && (
        <Tooltip content="定位收藏">
          <Button size="custom" className="h-[21px] w-[23px] shrink-0 p-0" aria-label="定位收藏" onClick={locate}><LocateFixed size={13} /></Button>
        </Tooltip>
      )}
    </div></div>}
  </article>
}

function NoteCard({ note, doc, act, search = false, onShare }: { note: Note; doc: Document; act: Act; search?: boolean; onShare?: (note: Note, share?: ShareRecord) => void }) {
  const selection = useSelection()
  const styles = linkCard({ note: true, search })
  const drag = useDragItem(search ? `search:${note.id}` : note.id, { kind: 'saved-item', itemKind: 'note', entityId: note.id, title: note.title }, styles.base(), search)
  const [error, setError] = useState('')
  const share = Object.values(doc.entities).find(
    (e): e is ShareRecord => e.kind === 'share' && !e.purged && e.entityId === note.id
  )
  async function open() {
    try { const data = await readLocalSnapshot(); await chrome.tabs.create({ url: documentUrl({ note: note.id, source: data.sourceId! }) }) }
    catch { setError('无法打开笔记，请重试') }
  }
  const noteIcon = <span className="grid place-items-center h-[20px] w-[20px] rounded-[5px] bg-[#eee5cb] text-[#9d8551]"><FileText size={16} /></span>
  return <article {...drag} data-selected={!search && selection.isSelected('saved', note.id) || undefined} aria-label={`笔记 ${note.title}`}>
    <div className={styles.top()}><span className={styles.icon()}>{search ? noteIcon : <SelectionIcon size="card" id={note.id} source="saved" title={note.title}>{noteIcon}</SelectionIcon>}</span><a className={styles.title()} href="#" onClick={event => { event.preventDefault(); void open() }}>{note.title}</a></div>
    <div className={styles.actions()}>
      {onShare && (
        <Tooltip content={share ? '查看已分享短链' : '分享笔记'}>
          <Button
            tone="custom"
            size="custom"
            className={cardAction({ tone: share ? 'share' : 'regular' })}
            aria-label={share ? '查看已分享短链' : '分享笔记'}
            onClick={() => onShare(note, share)}
          >
            <Share2 size={13} className={share ? 'stroke-[2.2]' : ''} />
          </Button>
        </Tooltip>
      )}
      <Button tone="custom" size="custom" className={cardAction({ tone: 'danger' })} aria-label="删除笔记" onClick={() => void act({ type: 'delete', id: note.id })}><Trash2 size={14} /></Button>
    </div>
    <span className={styles.domain()}>Markdown 笔记</span>
    <p className={styles.note()}>{markdownDescription(note.body)}</p><Toast message={error} onClose={() => setError('')}><Button onClick={() => { setError(''); void open() }}>重试打开</Button></Toast>
  </article>
}

export function CollectionSection({ collection, doc, act, edit, onShare, onShareCollection, isEditing = false, onStartEdit, onEndEdit }: { collection: Collection; doc: Document; act: Act; edit: (state: EditorState) => void; onShare?: (note: Note, share?: ShareRecord) => void; onShareCollection?: (collection: Collection, share?: ShareRecord) => void; isEditing?: boolean; onStartEdit?: () => void; onEndEdit?: () => void }) {
  const [collapsed, setCollapsed] = useState(collection.collapsed)
  const [prevPropCollapsed, setPrevPropCollapsed] = useState(collection.collapsed)
  const collapsedRef = useRef(collapsed)
  collapsedRef.current = collapsed
  const pendingAct = useRef<number>()
  const { inputRef, editingTitle, setEditingTitle, saveTitle, cancelTitle, handleKeyDown, handleBlur } = useInlineTitleEdit({
    title: collection.title,
    isEditing,
    scrollIntoView: true,
    onSave: async trimmed => {
      await act({ type: 'edit', id: collection.id, patch: { title: trimmed } })
    },
    onEndEdit,
  })

  if (prevPropCollapsed !== collection.collapsed) {
    setPrevPropCollapsed(collection.collapsed)
    setCollapsed(collection.collapsed)
  }

  useEffect(() => {
    const flush = () => {
      if (pendingAct.current) {
        clearTimeout(pendingAct.current)
        pendingAct.current = undefined
        void act({ type: 'edit', id: collection.id, patch: { collapsed: collapsedRef.current } })
      }
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [collection.id, act])

  const savedItems = children(doc, collection.id).filter((e): e is SavedItem => e.kind === 'link' || e.kind === 'note')
  const collectionShare = Object.values(doc.entities).find(
    (e): e is ShareRecord => e.kind === 'share' && !e.purged && e.entityKind === 'collection' && e.entityId === collection.id
  )
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState('')
  const [openModalVisible, setOpenModalVisible] = useState(false)
  const [openError, setOpenError] = useState('')
  async function createNote() {
    setCreating(true); setCreateError('')
    try {
      const id = crypto.randomUUID()
      if (!await act({ type: 'add-note', parentId: collection.id, id })) return
      const data = await readLocalSnapshot()
      await chrome.tabs.create({ url: documentUrl({ note: id, source: data.sourceId! }) })
    } catch { setCreateError('笔记已保存，打开失败，请从卡片重试') } finally { setCreating(false) }
  }
  const drag = useDragItem(collection.id, { kind: 'collection', entityId: collection.id, title: collection.title }, collectionStyles.base(), isEditing)
  const placeholder = useCollectionPlaceholder(doc, collection.id)
  const marker = placeholder && <CollectionPlaceholder collectionId={collection.id} target={placeholder.target} height={placeholder.height} />

  function toggleCollapsed() {
    const next = !collapsed
    setCollapsed(next)
    if (pendingAct.current) clearTimeout(pendingAct.current)
    pendingAct.current = window.setTimeout(() => {
      pendingAct.current = undefined
      void act({ type: 'edit', id: collection.id, patch: { collapsed: next } })
    }, 400)
  }

  return <section {...drag} aria-label={`收藏块 ${collection.title}`} id={`collection-${collection.id}`}>
    <div className={collectionStyles.header()}><div className={collectionStyles.heading()}>
      <Tooltip content={collapsed ? '展开收藏块' : '折叠收藏块'}>
        <Button size="custom" className="h-[26px] w-[24px] shrink-0 p-0 ml-[-5px]" aria-label={`${collapsed ? '展开' : '折叠'} ${collection.title}`} onClick={toggleCollapsed}>{collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}</Button>
      </Tooltip>
      {isEditing ? (
        <div className="flex items-center gap-[4px] min-w-0" onBlur={handleBlur} onPointerDown={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            className="h-[28px] text-[15px] font-semibold text-[#485b3d] bg-[#ffffffcc] border border-solid border-[#92a878] rounded-[6px] px-[8px] py-0 outline-none shadow-[0_0_0_2px_#92a87833] focus:border-[#718b56] min-w-[120px] max-w-[260px] [@media(max-width:650px)]:max-w-[160px]"
            aria-label="收藏块名称"
            value={editingTitle}
            maxLength={1000}
            onChange={e => setEditingTitle(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Tooltip content="确定">
            <Button
              tone="custom"
              size="custom"
              className="h-[26px] w-[26px] shrink-0 p-0 rounded-[6px] border border-solid border-transparent bg-transparent text-[#627d49] hover:bg-[#eaf0e0]"
              aria-label="确定"
              onMouseDown={e => e.preventDefault()}
              onClick={() => void saveTitle()}
            >
              <Check size={14} />
            </Button>
          </Tooltip>
          <Tooltip content="取消">
            <Button
              tone="custom"
              size="custom"
              className="h-[26px] w-[26px] shrink-0 p-0 rounded-[6px] border border-solid border-transparent bg-transparent text-[#8c9a7f] hover:bg-action-ghost-surface hover:text-[#5c6e4e]"
              aria-label="取消"
              onMouseDown={e => e.preventDefault()}
              onClick={() => void cancelTitle()}
            >
              <X size={14} />
            </Button>
          </Tooltip>
        </div>
      ) : (
        <h2
          className={`${collectionStyles.title()} group/col-title cursor-pointer select-none hover:bg-[#edf3e488] hover:text-[#2d3a24] px-[6px] py-[3px] -mx-[6px] -my-[3px] rounded-[7px] transition-all duration-150`}
          title="双击重命名收藏块"
          onDoubleClick={onStartEdit}
        >
          <span className="truncate">{collection.title}</span>
          <span className={collectionStyles.count()} aria-hidden="true">{savedItems.length}</span>
          <Pencil size={12} className="opacity-0 group-hover/col-title:opacity-60 transition-opacity text-[#71865b] shrink-0 ml-[2px]" aria-hidden="true" />
        </h2>
      )}
    </div>{!isEditing && <div className={collectionStyles.tools()}>
      <Tooltip content={savedItems.length ? '切换并打开' : '收藏块内暂无内容'}>
        <Button
          tone="custom"
          size="custom"
          className={collectionTool}
          aria-label={`切换并打开 ${collection.title}`}
          disabled={!savedItems.length}
          onClick={() => setOpenModalVisible(true)}
        >
          <ArrowUpDown size={14} />
        </Button>
      </Tooltip>
      <Tooltip content="新建笔记">
        <Button tone="custom" size="custom" className={collectionTool} aria-label={`新建笔记 ${collection.title}`} disabled={creating} onClick={() => void createNote()}><FilePlus2 size={14} /></Button>
      </Tooltip>
      {onShareCollection && (
        <Tooltip content={collectionShare ? '查看已分享短链' : '分享收藏块'}>
          <Button
            tone="custom"
            size="custom"
            className={collectionTool}
            aria-label={collectionShare ? `查看已分享短链 ${collection.title}` : `分享 ${collection.title}`}
            aria-pressed={!!collectionShare}
            onClick={() => onShareCollection(collection, collectionShare)}
          >
            <Share2 size={13} className={collectionShare ? 'text-[#627d49]' : ''} />
          </Button>
        </Tooltip>
      )}
      <Button tone="custom" size="custom" className={collectionTool} aria-label={`删除 ${collection.title}`} onClick={() => edit({ kind: 'delete', entity: collection })}><Trash2 size={13} /></Button>
    </div>}</div>
    <MotionRegion open={!collapsed || !!placeholder}>
      {savedItems.length || placeholder ? <SortableContext items={savedItems.map(item => item.id)} strategy={rectSortingStrategy}>
        <div className={cardGrid}>{savedItems.map(item => <Fragment key={item.id}>{placeholder?.beforeId === item.id && marker}{item.kind === 'note' ? <NoteCard note={item} doc={doc} act={act} onShare={onShare} /> : <Card link={item} act={act} edit={edit} />}</Fragment>)}{!placeholder?.beforeId && marker}</div>
      </SortableContext> : <div className="min-h-[104px] flex items-center justify-center gap-[16px] px-[18px] py-[20px] border border-dashed border-[#baca9e85] rounded-[12px] bg-[#fafcf34d]">
        <Folder size={32} strokeWidth={1.1} className="shrink-0 text-[#9eae88]" />
        <div><h3 className="text-[13px] font-medium text-[#6b7d5c]">暂无收藏</h3><p className="mt-[6px] text-[11px] text-[#839478]">从右侧拖入网页</p></div>
      </div>}
    </MotionRegion><Toast message={createError} onClose={() => setCreateError('')} />
    <Toast message={openError} onClose={() => setOpenError('')} />
    <ModalPresence>
      {openModalVisible && (
        <OpenCollectionModal
          collection={collection}
          itemCount={savedItems.length}
          close={() => setOpenModalVisible(false)}
          onConfirm={async strategy => {
            try {
              await openCollection(savedItems, strategy)
            } catch {
              setOpenError('打开收藏块失败，请重试')
            }
          }}
        />
      )}
    </ModalPresence>
  </section>
}

export function NewCollectionDraft({
  onSave,
  onCancel,
}: {
  onSave: (title: string) => Promise<void> | void
  onCancel: () => void
}) {
  const [title, setTitle] = useState('新收藏块')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
      inputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }, [])

  const handleSave = async () => {
    const trimmed = title.trim() || '新收藏块'
    await onSave(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void handleSave()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  const handleBlur = (e: React.FocusEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return
    const trimmed = title.trim()
    if (!trimmed) {
      onCancel()
    } else {
      void handleSave()
    }
  }

  return (
    <section className={collectionStyles.base()} aria-label="收藏块 新收藏块">
      <div className={collectionStyles.header()}><div className={collectionStyles.heading()}>
        <div className="flex items-center gap-[4px] min-w-0" onBlur={handleBlur} onPointerDown={e => e.stopPropagation()}>
          <input
            ref={inputRef}
            className="h-[28px] text-[15px] font-semibold text-[#485b3d] bg-[#ffffffcc] border border-solid border-[#92a878] rounded-[6px] px-[8px] py-0 outline-none shadow-[0_0_0_2px_#92a87833] focus:border-[#718b56] min-w-[120px] max-w-[260px] [@media(max-width:650px)]:max-w-[160px]"
            aria-label="收藏块名称"
            value={title}
            maxLength={1000}
            onChange={e => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Tooltip content="确定">
            <Button
              tone="custom"
              size="custom"
              className="h-[26px] w-[26px] shrink-0 p-0 rounded-[6px] border border-solid border-transparent bg-transparent text-[#627d49] hover:bg-[#eaf0e0]"
              aria-label="确定"
              onMouseDown={e => e.preventDefault()}
              onClick={() => void handleSave()}
            >
              <Check size={14} />
            </Button>
          </Tooltip>
          <Tooltip content="取消">
            <Button
              tone="custom"
              size="custom"
              className="h-[26px] w-[26px] shrink-0 p-0 rounded-[6px] border border-solid border-transparent bg-transparent text-[#8c9a7f] hover:bg-action-ghost-surface hover:text-[#5c6e4e]"
              aria-label="取消"
              onMouseDown={e => e.preventDefault()}
              onClick={onCancel}
            >
              <X size={14} />
            </Button>
          </Tooltip>
        </div>
      </div></div>
      <div className="min-h-[104px] flex items-center justify-center gap-[16px] px-[18px] py-[20px] border border-dashed border-[#baca9e85] rounded-[12px] bg-[#fafcf34d]">
        <Folder size={32} strokeWidth={1.1} className="shrink-0 text-[#9eae88]" />
        <div><h3 className="text-[13px] font-medium text-[#6b7d5c]">暂无收藏</h3><p className="mt-[6px] text-[11px] text-[#839478]">创建后可从右侧拖入网页</p></div>
      </div>
    </section>
  )
}

export function SearchView({ doc, act, edit, locate, onShare }: { doc: Document; act: Act; edit: (state: EditorState) => void; locate: (link: Link) => void; onShare?: (note: Note, share?: ShareRecord) => void }) {
  const [term, setTerm] = useState('')
  const savedItems = active(doc).filter((e): e is SavedItem => e.kind === 'link' || e.kind === 'note')
  const result = term.trim() ? savedItems.filter(item => `${item.title}\n${item.kind === 'note' ? item.body : item.url + '\n' + item.note}`.toLocaleLowerCase().includes(term.trim().toLocaleLowerCase())) : []
  return <><div className={searchStyles.field()}><Search size={19} /><input className={searchStyles.input()} aria-label="搜索全部收藏" type="search" placeholder="搜索标题、正文、网址或备注…" value={term} onChange={e => setTerm(e.target.value)} autoFocus data-autofocus /><kbd className={searchStyles.shortcut()}>全部空间</kbd></div>
    <p className={searchStyles.count()}>{term ? `找到 ${result.length} 个收藏` : `共 ${savedItems.length} 个收藏`}</p>
    <div className={searchStyles.results()}>{result.length ? <div className={cardGrid}>{result.map(item => item.kind === 'note' ? <NoteCard key={item.id} note={item} doc={doc} act={act} search onShare={onShare} /> : <Card key={item.id} link={item} act={act} edit={edit} location={locationName(doc, item)} locate={() => locate(item)} />)}</div> : <Empty icon="search" title={term ? '没有匹配的收藏' : '搜索收藏'} text={term ? '请尝试其他关键词' : ''} />}</div>
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
