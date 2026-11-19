import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Edit3, Folder, Layers3, Leaf, LoaderCircle, Plus, Search, Settings2, Share2, Trash2, X } from 'lucide-react'
import { tv } from 'tailwind-variants/lite'
import { active, children, type Action, type Collection, type Entity, type Link, type Note, type SavedItem, type ShareRecord } from '../core/model'
import { rpc, syncStatusLabels, type Snapshot } from '../core/protocol'
import ConnectionForm from './ConnectionForm'
import SettingsPanel from './SettingsPanel'
import RecycleBin from './RecycleBin'
import TabInbox, { useWindowTabs } from './TabInbox'
import { DragBoard, useDragItem } from './drag'
import TodoList from './TodoList'
import ShareManagementPanel from './ShareManagementPanel'
import { ShareModal } from './ShareModal'
import FluidBackground from './FluidBackground'
import { Brand, SidebarIdentity } from './SidebarIdentity'
import ContentPanel from './ContentPanel'
import Editor, { type EditorState } from './Editor'
import { CollectionSection, Empty, SearchView } from './Library'
import { Button, Modal, ModalPresence } from './ui'
import { Toast } from '../shared/Toast'
import QuickCollectionGap from './QuickCollectionGap'
import { collectionTitle, moveOpenTab, tabLink, type OpenTab } from './open-tabs'
import { documentUrl } from '../core/document-address'
import { markdownName, readDroppedMarkdown, rememberFile } from '../document/local-files'
import { SelectionProvider } from './Selection'
import BatchActions from './BatchActions'
import { createTabGroup } from './tab-groups'
import { closeSavedTabs, saveTabsBeforeClosing } from './tab-actions'

const workbench = tv({
  slots: {
    shell: 'workbench relative z-1 grid grid-cols-[226px_minmax(0,1fr)_288px] items-start h-[100dvh] overflow-hidden [@media(min-width:1700px)]:grid-cols-[245px_minmax(0,1fr)_320px] [@media(min-width:1000.01px)_and_(max-width:1200px)]:grid-cols-[205px_minmax(0,1fr)_250px] [@media(min-width:650.01px)_and_(max-width:1000px)]:grid-cols-[190px_minmax(0,1fr)] [@media(max-width:650px)]:grid-cols-[69px_minmax(0,1fr)]',
    sidebar: 'sidebar sticky top-0 z-1 h-[100dvh] flex flex-col pt-[34px] px-[20px] pb-[22px] border-r border-r-solid border-transparent [@media(max-width:1200px)]:pt-[28px] [@media(max-width:1200px)]:px-[14px] [@media(max-width:1200px)]:pb-[20px] [@media(max-width:650px)]:pt-[24px] [@media(max-width:650px)]:px-[9px] [@media(max-width:650px)]:pb-[18px]',
    section: 'flex items-center justify-between px-[11px] mt-[11px] mb-[9px] min-h-[29px] [@media(max-width:650px)]:hidden',
    createSection: 'flex items-center justify-between px-[11px] mt-[11px] mb-[9px] min-h-[29px] [@media(max-width:650px)]:justify-center [@media(max-width:650px)]:p-0 [@media(max-width:650px)]:mt-0 [@media(max-width:650px)]:mb-[10px]',
    sectionTitle: 'block text-[10px] [font-weight:650] tracking-[1px] text-[#989e90] [@media(max-width:650px)]:hidden',
    spaces: 'mb-[22px] overflow-auto max-h-[34vh] [@media(max-width:650px)]:mb-[30px] [@media(max-width:650px)]:max-h-[40vh]',
    sync: 'flex items-center gap-[7px] mt-[15px] mx-[13px] mb-0 text-[10px] text-[#9aa18f] bg-transparent border-0 [@media(max-width:650px)]:hidden',
    heading: 'flex items-center justify-between gap-[12px] mb-[10px] [@media(max-width:650px)]:items-start',
    pageHeader: 'pt-[30px] pb-[28px] [@media(max-width:650px)]:py-[25px]',
    title: 'text-[28px] tracking-[-.5px] font-semibold [line-height:1.5] [@media(max-width:650px)]:text-[24px]',
    loading: 'relative z-1 min-h-screen flex flex-col items-center justify-center gap-[18px] text-[#849571] text-[12px] bg-[#f8faef99]',
    onboarding: 'onboarding relative z-1 min-h-screen grid grid-cols-2 place-items-center p-[32px] [@media(max-width:650px)]:p-[20px]',
    panel: 'onboarding-panel w-[min(460px,100%)] max-w-[500px] p-[38px] m-auto bg-[#fffffbd4] border border-solid border-white rounded-[24px] shadow-[0_24px_100px_#536c3820] backdrop-blur-[22px] [@media(max-width:650px)]:p-[28px] [@media(max-width:650px)]:max-w-[480px]',
    connectTitle: 'mt-[32px] mb-[24px] text-[23px] [font-weight:550]',
    space: 'space-row group/space relative',
    tools: 'absolute right-[5px] top-[6px] flex bg-[#edf0e6] rounded-[6px] opacity-0 group-hover/space:opacity-100 group-focus-within/space:opacity-100 [@media(max-width:650px)]:hidden',
  },
})
const styles = workbench()
const navigation = tv({
  slots: {
    button: 'nav-item w-full min-w-0 flex items-center gap-[12px] px-[12px] py-[11px] mb-[5px] border-0 rounded-[9px] text-[12px] text-left [transition:background_.2s,box-shadow_.2s,color_.2s] hover:bg-[#e8f0dca6] [@media(max-width:650px)]:justify-center [@media(max-width:650px)]:px-[9px] [@media(max-width:650px)]:py-[13px] [@media(max-width:650px)]:min-h-[43px]',
    label: 'truncate [@media(max-width:650px)]:hidden',
    count: 'ml-auto text-[10px] bg-[#e5e8df] min-w-[19px] h-[19px] grid place-items-center rounded-[6px] [@media(max-width:650px)]:hidden',
    shortcut: 'ml-auto text-[10px] text-[#b6bcad] border border-solid border-[#e2e5d9] rounded-[3px] px-[4px] [@media(max-width:650px)]:hidden',
    symbol: 'flex',
    dot: 'w-[5px] h-[5px] rounded-full bg-[#859a70] ml-auto [@media(max-width:650px)]:hidden',
  },
  variants: { selected: {
    true: { button: 'selected bg-[#eff5e480] text-[#506442] font-semibold shadow-[inset_0_1px_0_#ffffff70] hover:text-[#506442]' },
    false: { button: 'bg-transparent text-[#878e7e] hover:text-[#556548]' },
  } },
  defaultVariants: { selected: false },
})
const nav = navigation()
const statusDot = tv({
  base: 'w-[5px] h-[5px] rounded-full shrink-0 inline-block',
  variants: { status: { synced: 'bg-[#9eb18b]', pending: 'bg-[#b2ad71]', syncing: 'bg-[#b2ad71]', error: 'bg-[#c99260]', conflict: 'bg-[#c99260]' } },
})

export const stateKey = ['workspace']
export default function NewTabApp() {
  const { data, error } = useQuery({ queryKey: stateKey, queryFn: async () => (await rpc({ type: 'snapshot' })).snapshot!, refetchInterval: 5000 })
  const profile = data?.document?.entities.profile
  const fluidAnimation = profile?.kind !== 'profile' || profile.fluidAnimation !== false
  const nickname = profile?.kind === 'profile' ? profile.title : undefined
  return <><FluidBackground fluidEnabled={fluidAnimation} nickname={nickname} /><Workbench data={data} error={error} /></>
}
function Workbench({ data, error }: { data: Snapshot | undefined; error: Error | null }) {
  const client = useQueryClient()
  const { tabs, groups, error: tabError, refresh: refreshTabs } = useWindowTabs()
  const [inboxOpen, setInboxOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState('')
  const [page, setPage] = useState('space')
  const [searchOpen, setSearchOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [sharingTarget, setSharingTarget] = useState<
    | { kind: 'note'; note: Note; share?: ShareRecord }
    | { kind: 'collection'; collection: Collection; share?: ShareRecord }
    | null
  >(null)
  const [collecting, setCollecting] = useState(false)
  const [grouping, setGrouping] = useState(false)
  const groupingRef = useRef(false)
  const collectingRef = useRef(false)
  const pendingClosures = useMemo(() => new Map<number, OpenTab>(), [data?.sourceId])
  const [collectionReveal, setCollectionReveal] = useState(0)
  useEffect(() => {
    let opening = false
    const dragover = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const drop = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) return
      const files = Array.from(event.dataTransfer.files || [])
      const items = Array.from(event.dataTransfer.items || [])
      const hasMarkdown =
        files.some(file => markdownName(file.name)) ||
        items.some(item => item.kind === 'file' && markdownName(item.getAsFile()?.name ?? ''))

      // 不是 md 文件时，不拦截也不报错，放行给浏览器或页面触发原有逻辑（如原生拖放打开）
      if (!hasMarkdown) {
        if (event.isTrusted) {
          event.stopPropagation()
        }
        return
      }

      // Native Chrome drops know the file URL; File/handle APIs hide that path.
      // Stop page handlers from cancelling Chrome's default open-in-new-tab.
      if (event.isTrusted && files.length === 1 && markdownName(files[0].name)) {
        event.stopPropagation()
        return
      }
      event.preventDefault(); event.stopPropagation()
      if (opening) return
      opening = true
      void readDroppedMarkdown(event.dataTransfer).then(rememberFile).then(local => chrome.tabs.create({ url: documentUrl({ local }) })).then(() => {
        opening = false
      }).catch(cause => { opening = false; setMessage(cause instanceof Error ? cause.message : '文件打开失败，请重新拖入') })
    }
    window.addEventListener('dragover', dragover, true)
    window.addEventListener('drop', drop, true)
    return () => { window.removeEventListener('dragover', dragover, true); window.removeEventListener('drop', drop, true) }
  }, [])
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
  const notices = <><Toast message={message} onClose={() => setMessage('')} /><Toast message={error?.message ?? ''}><Button onClick={() => void client.invalidateQueries({ queryKey: stateKey })}>重试</Button></Toast><Toast message={data?.error ?? ''} /></>
  if (!data) return <>{notices}<main className={styles.loading()}><Leaf size={32} /><p>{error ? '加载失败' : '正在加载…'}</p></main></>
  if (!data.document) return <>{notices}<main className={styles.onboarding()}><section className={styles.panel()}><Brand /><h1 className={styles.connectTitle()}>连接收藏库</h1><ConnectionForm connected={false} done={receive} onError={setMessage} /></section></main></>
  const doc = data.document
  const all = active(doc)
  const spaces = all.filter(e => e.kind === 'space')
  const space = spaces.find(e => e.id === selected) ?? spaces[0]
  const nickname = doc.entities.profile.title
  const collections = space ? children(doc, space.id).filter((e): e is Collection => e.kind === 'collection') : []
  const links = all.filter((e): e is Link => e.kind === 'link')
  const activeShares = Object.values(doc.entities).filter((e): e is ShareRecord => e.kind === 'share' && !e.purged)
  const status = syncStatusLabels[data.status]
  async function groupTabs() {
    if (groupingRef.current || !tabs.length || tabError) return
    groupingRef.current = true; setGrouping(true)
    try { await createTabGroup(tabs.map(tab => ({ ...tab }))) }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : '分组未完成，请重试') }
    finally { groupingRef.current = false; setGrouping(false); refreshTabs() }
  }
  function reveal(targetSpace: string) {
    setSelected(targetSpace); setPage('space'); setInboxOpen(false); setCollectionReveal(value => value + 1)
  }
  async function collectTabs() {
    if (collectingRef.current || !space || !tabs.length || tabError) return
    collectingRef.current = true; setCollecting(true)
    const snapshot = tabs.map(tab => ({ ...tab }))
    const targetSpace = space.id
    try {
      if (!await saveTabsBeforeClosing(snapshot, pendingClosures, unsaved => act({ type: 'collect-tabs', parentId: targetSpace, title: collectionTitle(), links: unsaved.map(tabLink) }))) return
      setSelected(targetSpace); setPage('space'); setInboxOpen(false)
      setCollectionReveal(value => value + 1)
      const notices = new Set<string>()
      await closeSavedTabs(snapshot, pendingClosures, message => notices.add(message))
      if (notices.size) setMessage([...notices].join('；'))
    } finally { collectingRef.current = false; setCollecting(false); refreshTabs() }
  }
  function locate(item: SavedItem) {
    setSearchOpen(false)
    const collection = doc.entities[item.parentId!]
    if (!collection) return
    setSelected(collection.parentId!); setPage('space')
    if (collection.kind === 'collection' && collection.collapsed) void act({ type: 'edit', id: collection.id, patch: { collapsed: false } })
    setTimeout(() => document.getElementById(`collection-${collection.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100)
  }
  return <SelectionProvider key={data.sourceId} pendingClosures={pendingClosures} externalBusy={collecting || grouping} scope={`${page}:${space?.id ?? ''}:${searchOpen}`} orders={{ tabs: tabs.map(tab => String(tab.tabId)), saved: collections.flatMap(collection => children(doc, collection.id).filter(item => item.kind === 'link' || item.kind === 'note').map(item => item.id)) }}><DragBoard doc={doc} tabs={tabs} refreshTabs={refreshTabs} act={act} notify={setMessage} moveTab={async (source, target) => { try { return await moveOpenTab(source, target, setMessage) } finally { refreshTabs() } }}><div className={styles.shell()} onDragOver={event => event.preventDefault()} onDrop={event => event.preventDefault()}>
    {notices}
    <aside className={styles.sidebar()}><SidebarIdentity nickname={nickname} reserve />
      <div className={styles.createSection()}><span className={styles.sectionTitle()}>我的空间</span><Button size="custom" className="h-[22px] w-[22px] shrink-0 p-0" aria-label="新建空间" onClick={() => setEditor({ kind: 'space' })}><Plus size={15} /></Button></div>
      <SortableContext items={spaces.map(item => item.id)} strategy={verticalListSortingStrategy}><nav className={styles.spaces()} aria-label="空间">{spaces.map(item => <SpaceRow key={item.id} item={item} selected={page === 'space' && space?.id === item.id} select={() => { setSelected(item.id); setPage('space') }} rename={() => setEditor({ kind: 'rename', entity: item })} remove={() => setEditor({ kind: 'delete', entity: item })} />)}</nav></SortableContext>
      <div className={styles.section()}><span className={styles.sectionTitle()}>工作台</span></div><nav>
        <button aria-label={`Todo ${links.filter(l => l.todo).length}`} title="Todo" className={navigation({ selected: page === 'todo' }).button()} onClick={() => setPage('todo')}><Bookmark size={18} /><span className={nav.label()}>Todo</span><span className={nav.count()}>{links.filter(l => l.todo).length}</span></button>
        <button aria-label={`分享管理 ${activeShares.length}`} title="分享管理" className={navigation({ selected: page === 'shares' }).button()} onClick={() => setPage('shares')}><Share2 size={18} /><span className={nav.label()}>分享管理</span>{!!activeShares.length && <span className={nav.count()}>{activeShares.length}</span>}</button>
        <button aria-label="搜索收藏" title="搜索收藏" className={navigation({ selected: searchOpen }).button()} onClick={() => setSearchOpen(true)}><Search size={18} /><span className={nav.label()}>搜索收藏</span><kbd className={nav.shortcut()}>/</kbd></button>
      </nav>
      <div className="mt-auto"><RecycleBin doc={doc} act={act} /><button aria-label="设置" title="设置" className={navigation({ selected: page === 'settings' }).button()} onClick={() => setPage('settings')}><Settings2 size={18} /><span className={nav.label()}>设置</span></button><button className={styles.sync()} onClick={() => setPage('settings')}><span className={statusDot({ status: data.status })} />{status}{data.status === 'syncing' && <LoaderCircle size={13} className="animate-spin" />}</button></div>
    </aside>
    <ContentPanel scrollKey={`${page}:${space?.id ?? ''}:${collectionReveal}`} header={<>
      <div className={styles.heading()}><header className={styles.pageHeader()}><h1 className={styles.title()}>{page === 'space' ? space?.title ?? '我的空间' : page === 'todo' ? 'Todo' : page === 'shares' ? '分享管理' : page === 'settings' ? '设置' : '搜索收藏'}</h1></header>{page === 'space' && space && <Button tone="primary" size="custom" className="px-[12px] py-[10px] text-[10px] [@media(max-width:650px)]:text-[0px] [@media(max-width:650px)]:w-[30px] [@media(max-width:650px)]:h-[30px] [@media(max-width:650px)]:p-0 [@media(max-width:650px)]:shrink-0 [@media(max-width:650px)]:mt-[24px] [@media(max-width:650px)]:[&_svg]:w-[16px]" aria-label="新建收藏块" onClick={() => setEditor({ kind: 'collection', parentId: space.id })}><Plus size={15} />新建收藏块</Button>}</div>
    </>}>
      {page === 'space' && <SortableContext items={collections.map(c => c.id)} strategy={verticalListSortingStrategy}>{collections.map(collection => <Fragment key={collection.id}><QuickCollectionGap spaceId={space.id} beforeId={collection.id} /><CollectionSection collection={collection} doc={doc} act={act} edit={setEditor} onShare={(note, share) => setSharingTarget({ kind: 'note', note, share })} onShareCollection={(collection, share) => setSharingTarget({ kind: 'collection', collection, share })} /></Fragment>)}{!!collections.length && <QuickCollectionGap spaceId={space.id} />}{!collections.length && <Empty icon="collection" title="暂无收藏块" text=""><Button tone="primary" size="custom" className="mt-[21px] px-[13px] py-[9px] text-[11px]" onClick={() => setEditor({ kind: 'collection', parentId: space.id })}><Plus size={15} />创建收藏块</Button></Empty>}</SortableContext>}
      {page === 'todo' && <TodoList doc={doc} act={act} />}
      {page === 'shares' && <ShareManagementPanel doc={doc} act={act} onLocateNote={id => { const n = doc.entities[id]; if (n && (n.kind === 'note' || n.kind === 'link')) locate(n) }} />}
      {page === 'settings' && <SettingsPanel key={data.sourceId} data={{ ...data, document: doc }} act={act} receive={receive} onError={setMessage} />}
    </ContentPanel>
    <Button tone="primary" className="[@media(min-width:1000.01px)]:hidden fixed right-[18px] bottom-[18px] z-21 [box-shadow:0_5px_22px_#40552d33]" aria-label="打开待选网页" onClick={() => setInboxOpen(value => !value)}><Layers3 size={16} />待选网页 {tabs.length}</Button><TabInbox tabs={tabs} groups={groups} groupAll={() => void groupTabs()} grouping={grouping} error={tabError} open={inboxOpen} close={() => setInboxOpen(false)} collect={() => void collectTabs()} collecting={collecting} notify={setMessage} />
    <BatchActions key={data.sourceId} doc={doc} sourceId={data.sourceId!} spaceId={space?.id} tabs={tabs} act={act} notify={setMessage} refreshTabs={refreshTabs} reveal={reveal} />
    <ModalPresence>{searchOpen && <Modal title="搜索收藏" close={() => setSearchOpen(false)} size="search"><SearchView doc={doc} act={act} edit={setEditor} locate={locate} onShare={(note, share) => setSharingTarget({ kind: 'note', note, share })} /></Modal>}</ModalPresence>
    <ModalPresence>{editor && <Editor key={'entity' in editor ? editor.entity.id : editor.kind} state={editor} doc={doc} act={act} close={() => setEditor(null)} />}</ModalPresence>
    <ModalPresence>{sharingTarget && <ShareModal target={sharingTarget} share={sharingTarget.share} doc={doc} act={act} close={() => setSharingTarget(null)} onNavigateToShares={() => { setSharingTarget(null); setPage('shares') }} onNavigateToSettings={() => { setSharingTarget(null); setPage('settings') }} />}</ModalPresence>
  </div></DragBoard></SelectionProvider>
}
function SpaceRow({ item, selected, select, rename, remove }: { item: Entity; selected: boolean; select: () => void; rename: () => void; remove: () => void }) {
  const drag = useDragItem(item.id, { kind: 'space', entityId: item.id, title: item.title }, styles.space())
  return <div {...drag}><button aria-label={item.title} title={item.title} className={navigation({ selected }).button()} onClick={select}><span className={nav.symbol()}><Folder size={17} /></span><span className={nav.label({ className: 'group-hover/space:max-w-[85px]' })}>{item.title}</span>{selected && <span className={nav.dot()} />}</button><div className={styles.tools()}><Button size="custom" className="h-[26px] w-[23px] shrink-0 p-0" aria-label={`重命名空间 ${item.title}`} onClick={rename}><Edit3 size={12} /></Button><Button size="custom" className="h-[26px] w-[23px] shrink-0 p-0" aria-label={`删除空间 ${item.title}`} onClick={remove}><Trash2 size={12} /></Button></div></div>
}
