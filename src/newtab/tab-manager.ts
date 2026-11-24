import type { LinkInput, SavedItem } from '../core/model'
import { savedUrl } from '../core/model'
import { documentUrl, isMarkdownUrl } from '../core/markdown'
import { readLocalSnapshot } from '../core/local-workspace'
import type { OpenCollectionStrategy } from './OpenCollectionModal'

export type OpenTab = LinkInput & {
  tabId: number
  windowId: number
  pinned: boolean
  index: number
  groupId: number
}

export type TabSlot = {
  windowId: number
  groupId: number
  index: number
  beforeTabId?: number
}

export type WindowTabGroup = chrome.tabGroups.TabGroup & {
  memberCount: number
  firstIndex: number
  lastIndex: number
}

type GroupTab = Pick<OpenTab, 'tabId' | 'windowId'> & { url?: string }

// Internal state & helpers
const unfinishedGroups = new Map<string, { id: number; title: string; tabIds: [number, ...number[]] }>()

export function nextGroupName(existingTitles: Iterable<string | undefined | null>): string {
  const titles = new Set(Array.from(existingTitles).filter(Boolean))
  let sequence = 1
  while (titles.has(`分组${sequence}`)) sequence++
  return `分组${sequence}`
}

export function collectionTitle(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `收藏 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function tabLink(tab: OpenTab): LinkInput {
  return { title: tab.title, url: tab.url, icon: tab.icon }
}

export function canSortTabs(source: OpenTab, target: OpenTab): boolean {
  return source.windowId === target.windowId && source.pinned === target.pinned
}

export async function moveOpenTab(source: OpenTab, target: OpenTab, notify: (message: string) => void): Promise<boolean> {
  try {
    const [current, destination] = await Promise.all([chrome.tabs.get(source.tabId), chrome.tabs.get(target.tabId)])
    if (
      !canSortTabs(source, target) ||
      current.windowId !== source.windowId ||
      destination.windowId !== target.windowId ||
      current.pinned !== source.pinned ||
      destination.pinned !== target.pinned ||
      current.index !== source.index ||
      destination.index !== target.index
    ) {
      notify('标签页已变化，请重新排序')
      return false
    }
    await chrome.tabs.move(source.tabId, { index: destination.index })
    return true
  } catch {
    notify('无法调整标签页顺序，请重试')
    return false
  }
}

async function currentTabs(snapshot: GroupTab[]) {
  if (!snapshot.length) throw new Error('没有可操作的标签页')
  const windowId = snapshot[0].windowId
  const tabs = await Promise.all(
    snapshot.map(async tab => {
      const current = await chrome.tabs.get(tab.tabId)
      if (
        tab.windowId !== windowId ||
        current.windowId !== windowId ||
        (tab.url !== undefined && (current.pendingUrl || current.url) !== tab.url)
      ) {
        throw new Error('标签页已变化，请重新选择')
      }
      return current
    })
  )
  return { tabs, windowId }
}

export async function createTabGroup(snapshot: GroupTab[], options?: { title?: string; collapsed?: boolean }): Promise<number> {
  const { tabs, windowId } = await currentTabs(snapshot)
  const key = `${windowId}:${tabs.map(tab => tab.id!).sort((a, b) => a - b).join(',')}`
  let unfinished = unfinishedGroups.get(key)

  if (unfinished) {
    const group = await chrome.tabGroups.get(unfinished.id).catch(() => undefined)
    const members = group && (await chrome.tabs.query({ windowId, groupId: group.id }))
    if (
      !group ||
      group.windowId !== windowId ||
      members?.length !== tabs.length ||
      !tabs.every(tab => members.some(member => member.id === tab.id)) ||
      (group.title && group.title !== unfinished.title)
    ) {
      unfinishedGroups.delete(key)
      unfinished = undefined
    }
  }

  if (!unfinished) {
    const existingGroups = await chrome.tabGroups.query({ windowId })
    const title = options?.title ?? nextGroupName(existingGroups.map(g => g.title))
    for (const tab of tabs) {
      if (tab.pinned) await chrome.tabs.update(tab.id!, { pinned: false })
    }
    const tabIds: [number, ...number[]] = [tabs[0].id!, ...tabs.slice(1).map(tab => tab.id!)]
    const id = await chrome.tabs.group({ tabIds, createProperties: { windowId } })
    unfinished = { id, title, tabIds }
    unfinishedGroups.set(key, unfinished)
  }

  const collapsed = options?.collapsed ?? false
  await chrome.tabGroups.update(unfinished.id, { title: unfinished.title, collapsed })
  const grouped = (await chrome.tabs.query({ windowId, groupId: unfinished.id })).sort((a, b) => a.index - b.index)
  if (grouped.length) await chrome.tabs.move(unfinished.tabIds, { index: grouped[0].index })
  unfinishedGroups.delete(key)
  return unfinished.id
}

export async function moveTabsToSlot(snapshot: OpenTab[], target: TabSlot): Promise<void> {
  const { tabs, windowId } = await currentTabs(snapshot)
  if (windowId !== target.windowId) throw new Error('标签页不能跨窗口移动')
  const original = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index)
  const moving = new Set(tabs.map(tab => tab.id!))
  const targetTab = target.beforeTabId === undefined ? undefined : original.find(tab => tab.id === target.beforeTabId)
  if (target.beforeTabId !== undefined && (!targetTab || (target.groupId !== -1 && targetTab.groupId !== target.groupId))) {
    throw new Error('拖拽位置已变化，请重新拖动')
  }
  const anchor = original.find(tab => !moving.has(tab.id!) && tab.index >= (targetTab?.index ?? target.index))?.id
  const tabIds: [number, ...number[]] = [tabs[0].id!, ...tabs.slice(1).map(tab => tab.id!)]
  if (target.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const group = await chrome.tabGroups.get(target.groupId)
    if (group.windowId !== windowId) throw new Error('分组已变化，请重新拖动')
    for (const tab of tabs) if (tab.pinned) await chrome.tabs.update(tab.id!, { pinned: false })
    await chrome.tabs.group({ tabIds, groupId: target.groupId })
  } else {
    const pinnedCount = original.filter(tab => tab.pinned).length
    if (tabs.some(tab => tab.pinned !== tabs[0].pinned) || (tabs[0].pinned ? target.index > pinnedCount : target.index < pinnedCount)) {
      throw new Error('置顶标签和普通标签只能分别排序')
    }
    await chrome.tabs.ungroup(tabIds)
  }
  const latest = (await chrome.tabs.query({ windowId })).sort((a, b) => a.index - b.index)
  const remaining = latest.filter(tab => !moving.has(tab.id!))
  const index = anchor === undefined ? remaining.length : remaining.findIndex(tab => tab.id === anchor)
  if (index < 0) throw new Error('拖拽位置已变化，请重新拖动')
  await chrome.tabs.move(tabIds, { index })
}

export async function moveWholeGroup(groupId: number, windowId: number, index: number): Promise<void> {
  const current = await chrome.tabGroups.get(groupId)
  if (current.windowId !== windowId) throw new Error('分组已移出当前窗口，请重新拖动')
  await chrome.tabs.move(groupId, { index })
}

export async function saveTabsBeforeClosing(
  tabs: OpenTab[],
  pending: Map<number, OpenTab>,
  save: (unsaved: OpenTab[]) => Promise<boolean>
): Promise<boolean> {
  const unsaved = tabs.filter(tab => !pending.has(tab.tabId))
  if (unsaved.length && !(await save(unsaved))) return false
  unsaved.forEach(tab => pending.set(tab.tabId, tab))
  return true
}

export async function closeSavedTabs(
  tabs: OpenTab[],
  pending: Map<number, OpenTab>,
  notify: (message: string) => void
): Promise<string[]> {
  const failed: string[] = []
  for (const tab of tabs) {
    const snapshot = pending.get(tab.tabId) ?? tab
    try {
      let current: chrome.tabs.Tab
      try {
        current = await chrome.tabs.get(snapshot.tabId)
      } catch (cause) {
        if (cause instanceof Error && /No tab with id/i.test(cause.message)) {
          pending.delete(snapshot.tabId)
          continue
        }
        throw cause
      }
      if ((current.pendingUrl || current.url) !== snapshot.url || current.windowId !== snapshot.windowId) {
        pending.delete(snapshot.tabId)
        notify(`收藏已保存，原标签页已变化，已保留当前页面：${snapshot.title}`)
        continue
      }
      await chrome.tabs.remove(snapshot.tabId)
      pending.delete(snapshot.tabId)
    } catch {
      pending.set(snapshot.tabId, snapshot)
      failed.push(String(snapshot.tabId))
      notify(`已收藏，关闭未完成，无法关闭原标签页，请重试关闭：${snapshot.title}`)
    }
  }
  return failed
}

export async function openCollection(items: SavedItem[], strategy: OpenCollectionStrategy): Promise<void> {
  if (!items.length) return

  const currentTab = await chrome.tabs.getCurrent()
  if (!currentTab?.id || currentTab.windowId === undefined) throw new Error('无法获取当前窗口')
  const currentTabId = currentTab.id
  const windowId = currentTab.windowId

  const [allTabs, allGroups] = await Promise.all([
    chrome.tabs.query({ windowId }),
    chrome.tabGroups.query({ windowId }),
  ])

  // 1. If strategy is 'collapse': collapse existing groups and bundle loose tabs
  if (strategy === 'collapse') {
    await Promise.all(allGroups.map(g => chrome.tabGroups.update(g.id, { collapsed: true })))

    const looseTabs = allTabs.filter(
      t => !t.pinned && t.id !== currentTabId && t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE
    )
    if (looseTabs.length > 0) {
      const title = nextGroupName(allGroups.map(g => g.title))
      const tabIds: [number, ...number[]] = [looseTabs[0].id!, ...looseTabs.slice(1).map(t => t.id!)]
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } })
      await chrome.tabGroups.update(groupId, { title, collapsed: true })
    }
  }

  // 2. Open collection items in order
  const snapshot = await readLocalSnapshot().catch(() => null)
  const sourceId = snapshot?.sourceId ?? ''

  const createdTabIds: number[] = []
  for (const item of items) {
    let url: string
    if (item.kind === 'note') {
      url = documentUrl({ note: item.id, source: sourceId })
    } else {
      url = isMarkdownUrl(item.url) ? documentUrl({ url: item.url }) : savedUrl(item.url)
    }
    const tab = await chrome.tabs.create({ windowId, url, active: false })
    if (tab.id !== undefined) createdTabIds.push(tab.id)
  }

  // 3. Activate the first newly opened tab
  if (createdTabIds.length > 0) {
    await chrome.tabs.update(createdTabIds[0], { active: true })
  }

  // 4. If strategy is 'clear': close previous non-pinned tabs and current extension page
  if (strategy === 'clear') {
    const tabsToClose = allTabs.filter(
      t => !t.pinned && t.id !== currentTabId && !createdTabIds.includes(t.id!)
    )
    if (tabsToClose.length > 0) {
      await chrome.tabs.remove(tabsToClose.map(t => t.id!)).catch(() => {})
    }
    await chrome.tabs.remove(currentTabId).catch(() => {})
  }
}
