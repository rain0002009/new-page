import { useEffect, useRef, useState } from 'react'
import { BookmarkPlus, FolderInput, Group, LoaderCircle, Trash2, X } from 'lucide-react'
import { active, children, type Collection, type Document, type SavedItem } from '../core/model'
import { documentUrl, isMarkdownUrl } from '../core/markdown'
import type { Act } from './Editor'
import { Button, Modal, ModalPresence } from './ui'
import { useSelection } from './Selection'
import { collectionTitle, tabLink, type OpenTab } from './open-tabs'
import { createTabGroup } from './tab-groups'
import { closeSavedTabs, saveTabsBeforeClosing } from './tab-actions'

type Props = { doc: Document; sourceId: string; spaceId?: string; tabs: OpenTab[]; act: Act; notify: (message: string) => void; refreshTabs: () => void; reveal: (spaceId: string) => void }
export default function BatchActions({ doc, sourceId, spaceId, tabs, act, notify, refreshTabs, reveal }: Props) {
  const selection = useSelection()
  const lock = useRef(false)
  const [dialog, setDialog] = useState<'target' | 'delete' | null>(null)
  const [targetSpace, setTargetSpace] = useState(spaceId ?? '')
  const [targetCollection, setTargetCollection] = useState('')
  const opened = useRef(new Map<string, OpenTab>())
  useEffect(() => { if (!selection.ids.length) setDialog(null) }, [selection.ids.length])
  const saved = selection.source === 'saved'
  const selectedTabs = tabs.filter(tab => selection.ids.includes(String(tab.tabId)))
  const selectedItems = selection.ids.map(id => doc.entities[id]).filter((item): item is SavedItem => !!item && (item.kind === 'link' || item.kind === 'note'))
  const notes = selectedItems.filter(item => item.kind === 'note').length
  const spaces = active(doc).filter(item => item.kind === 'space' && (!saved || item.id === spaceId))
  const targets = children(doc, targetSpace).filter((item): item is Collection => item.kind === 'collection')
  async function run(operation: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; selection.setBusy(true)
    try { await operation() }
    catch (cause) { notify(cause instanceof Error ? cause.message : '操作未完成，请重试') }
    finally { lock.current = false; selection.setBusy(false); refreshTabs() }
  }
  async function collect(target?: string) {
    if (!spaceId) return
    const destinationSpace = target ? doc.entities[target]?.parentId : spaceId
    if (!destinationSpace) { notify('目标收藏块已变化，请重新选择'); return }
    const snapshot = selectedTabs.map(tab => ({ ...tab }))
    if (saved) {
      const success = await act(target ? { type: 'move-items', ids: [...selection.ids], parentId: target } : { type: 'collect-items', ids: [...selection.ids], parentId: spaceId, title: collectionTitle() })
      if (success) { selection.clear(); setDialog(null); reveal(destinationSpace) }
      return
    }
    if (!await saveTabsBeforeClosing(snapshot, selection.pendingClosures, unsaved => act(target ? { type: 'add-links', parentId: target, links: unsaved.map(tabLink) } : { type: 'collect-tabs', parentId: spaceId, title: collectionTitle(), links: unsaved.map(tabLink) }))) return
    setDialog(null)
    const failed = await closeSavedTabs(snapshot, selection.pendingClosures, notify)
    selection.retain(failed)
    if (!failed.length) reveal(destinationSpace)
  }
  async function group() {
    if (!saved) {
      await createTabGroup(selectedTabs.map(tab => ({ ...tab })))
      selection.clear()
      return
    }
    const currentWindow = await chrome.windows.getCurrent()
    const failed: string[] = []
    const ready: { id: string; tab: OpenTab }[] = []
    for (const item of selectedItems) {
      try {
        let previous = opened.current.get(item.id)
        if (previous) {
          const actual = await chrome.tabs.get(previous.tabId).catch(() => null)
          if (!actual || actual.windowId !== currentWindow.id) { opened.current.delete(item.id); previous = undefined }
        }
        if (!previous) {
          const address = item.kind === 'note' ? documentUrl({ note: item.id, source: sourceId }) : isMarkdownUrl(item.url) ? documentUrl({ url: item.url }) : item.url
          const created = await chrome.tabs.create({ windowId: currentWindow.id, url: address, active: false })
          previous = { tabId: created.id!, windowId: created.windowId, index: created.index, pinned: false, groupId: created.groupId, title: item.title, url: created.pendingUrl || created.url || address, icon: item.kind === 'link' ? item.icon : '' }
          opened.current.set(item.id, previous)
        }
        ready.push({ id: item.id, tab: previous })
      } catch { failed.push(item.id) }
    }
    if (ready.length) {
      // Newly opened pages may redirect while the rest of the batch opens.
      // Their tab identities define this operation; inbox snapshots keep URL guards.
      try { await createTabGroup(ready.map(({ tab }) => ({ tabId: tab.tabId, windowId: tab.windowId }))); ready.forEach(item => opened.current.delete(item.id)) }
      catch (cause) { failed.push(...ready.map(item => item.id)); notify(cause instanceof Error ? cause.message : '新页面已打开，分组未完成，可重试') }
    }
    selection.retain(failed)
    if (failed.length) notify('部分内容未完成在新分组中打开，请重试；已打开的待分组页面将继续使用')
  }
  async function remove() {
    if (saved) {
      if (await act({ type: 'delete-items', ids: [...selection.ids] })) { selection.clear(); setDialog(null) }
      return
    }
    const failed: string[] = []
    for (const tab of selectedTabs) {
      try {
        const current = await chrome.tabs.get(tab.tabId).catch(() => null)
        if (!current) continue
        if (current.windowId !== tab.windowId || (current.pendingUrl || current.url) !== tab.url) { notify(`标签页已变化，已保留：${tab.title}`); continue }
        await chrome.tabs.remove(tab.tabId)
        selection.pendingClosures.delete(tab.tabId)
      } catch { failed.push(String(tab.tabId)) }
    }
    selection.retain(failed)
    if (failed.length) notify('部分标签页无法关闭，请重试')
  }
  if (!selection.ids.length) return null
  return <>
    <div role="toolbar" aria-label="批量操作" aria-busy={selection.busy} className="fixed z-40 bottom-[24px] left-1/2 -translate-x-1/2 flex max-w-[calc(100vw-24px)] flex-wrap items-center justify-center gap-[4px] rounded-[16px] border border-solid border-white bg-ui-dialog px-[12px] py-[9px] shadow-[0_8px_35px_#334c2b33] backdrop-blur-[22px] [@media(max-width:650px)]:bottom-[72px] [@media(max-width:650px)]:gap-[2px] [@media(max-width:650px)]:w-[calc(100vw-24px)]">
      <span className="px-[6px] text-[12px] text-[#566a47]" role="status">已选 {selection.ids.length} 项</span>
      <Button disabled={selection.busy} onClick={selection.selectAll}>全选</Button>
      <Button disabled={selection.busy} title={saved ? '在新分组中打开' : '将所选标签加入新分组'} onClick={() => void run(group)}><Group size={16} />分组</Button>
      <Button disabled={selection.busy} onClick={() => { setTargetSpace(spaceId ?? spaces[0]?.id ?? ''); setTargetCollection(''); setDialog('target') }}><FolderInput size={16} />{saved ? '移动到收藏块' : '添加到对应收藏'}</Button>
      <Button disabled={selection.busy || !spaceId} onClick={() => void run(() => collect())}><BookmarkPlus size={16} />快速收藏</Button>
      <Button tone="danger" disabled={selection.busy} onClick={() => saved && notes ? setDialog('delete') : void run(remove)}><Trash2 size={16} />删除</Button>
      <Button size="icon" aria-label="取消选择" title="取消选择" disabled={selection.busy} onClick={selection.clear}>{selection.busy ? <LoaderCircle size={16} className="animate-spin" /> : <X size={16} />}</Button>
    </div>
    <ModalPresence>{dialog === 'target' && <Modal title={saved ? '移动到收藏块' : '添加到对应收藏'} close={() => { if (!selection.busy) setDialog(null) }}>
      <div className="flex flex-col gap-[16px] text-[13px]">
        <label className="flex flex-col gap-[7px]">空间<select aria-label="空间" disabled={selection.busy} value={targetSpace} onChange={event => { setTargetSpace(event.target.value); setTargetCollection('') }}>{spaces.map(space => <option key={space.id} value={space.id}>{space.title}</option>)}</select></label>
        <label className="flex flex-col gap-[7px]">收藏块<select aria-label="收藏块" disabled={selection.busy} value={targetCollection} onChange={event => setTargetCollection(event.target.value)}><option value="">请选择收藏块</option>{targets.map(collection => <option key={collection.id} value={collection.id}>{collection.title}</option>)}</select></label>
        {!targets.length && <p>该空间暂无收藏块，请先创建收藏块。</p>}
        <div className="flex justify-end gap-[8px]"><Button disabled={selection.busy} onClick={() => setDialog(null)}>取消</Button><Button tone="primary" disabled={selection.busy || !targets.some(item => item.id === targetCollection)} onClick={() => void run(() => collect(targetCollection))}>确认{saved ? '移动' : '收藏'}</Button></div>
      </div>
    </Modal>}</ModalPresence>
    <ModalPresence>{dialog === 'delete' && <Modal title="删除所选内容" close={() => { if (!selection.busy) setDialog(null) }}><p className="text-[13px]">将永久删除 {notes} 篇笔记，无法从回收站恢复。所选链接将进入回收站。</p><div className="mt-[20px] flex justify-end gap-[8px]"><Button disabled={selection.busy} onClick={() => setDialog(null)}>取消</Button><Button tone="danger" disabled={selection.busy} onClick={() => void run(remove)}>确认删除所选</Button></div></Modal>}</ModalPresence>
  </>
}
