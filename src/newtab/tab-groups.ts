import type { OpenTab } from './open-tabs'

export type TabSlot = { windowId: number; groupId: number; index: number; beforeTabId?: number }
export type WindowTabGroup = chrome.tabGroups.TabGroup & { memberCount: number; firstIndex: number; lastIndex: number }

const unfinishedGroups = new Map<string, { id: number; title: string; tabIds: [number, ...number[]] }>()
type GroupTab = Pick<OpenTab, 'tabId' | 'windowId'> & { url?: string }

async function currentTabs(snapshot: GroupTab[]) {
  if (!snapshot.length) throw new Error('没有可操作的标签页')
  const windowId = snapshot[0].windowId
  const tabs = await Promise.all(snapshot.map(async tab => {
    const current = await chrome.tabs.get(tab.tabId)
    if (tab.windowId !== windowId || current.windowId !== windowId || (tab.url !== undefined && (current.pendingUrl || current.url) !== tab.url)) {
      throw new Error('标签页已变化，请重新选择')
    }
    return current
  }))
  return { tabs, windowId }
}

export async function createTabGroup(snapshot: GroupTab[]): Promise<number> {
  const { tabs, windowId } = await currentTabs(snapshot)
  const key = `${windowId}:${tabs.map(tab => tab.id!).sort((a, b) => a - b).join(',')}`
  let unfinished = unfinishedGroups.get(key)
  if (unfinished) {
    const group = await chrome.tabGroups.get(unfinished.id).catch(() => undefined)
    const members = group && await chrome.tabs.query({ windowId, groupId: group.id })
    if (!group || group.windowId !== windowId || members?.length !== tabs.length || !tabs.every(tab => members.some(member => member.id === tab.id)) || (group.title && group.title !== unfinished.title)) {
      unfinishedGroups.delete(key)
      unfinished = undefined
    }
  }
  if (!unfinished) {
    const names = new Set((await chrome.tabGroups.query({ windowId })).map(group => group.title))
    let sequence = 1
    while (names.has(`分组${sequence}`)) sequence++
    for (const tab of tabs) if (tab.pinned) await chrome.tabs.update(tab.id!, { pinned: false })
    const tabIds: [number, ...number[]] = [tabs[0].id!, ...tabs.slice(1).map(tab => tab.id!)]
    const id = await chrome.tabs.group({ tabIds, createProperties: { windowId } })
    unfinished = { id, title: `分组${sequence}`, tabIds }
    // Remember a group created before a later step fails, so retry completes
    // its naming/order instead of creating another group for the same tabs.
    unfinishedGroups.set(key, unfinished)
  }
  await chrome.tabGroups.update(unfinished.id, { title: unfinished.title, collapsed: false })
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
  await chrome.tabGroups.move(groupId, { index })
}
