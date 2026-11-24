import type { SavedItem } from '../core/model'
import { savedUrl } from '../core/model'
import { documentUrl, isMarkdownUrl } from '../core/markdown'
import { readLocalSnapshot } from '../core/local-workspace'
import type { OpenCollectionStrategy } from './OpenCollectionModal'

export async function openCollection(
  items: SavedItem[],
  strategy: OpenCollectionStrategy
): Promise<void> {
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
      const existingTitles = new Set(allGroups.map(g => g.title).filter(Boolean))
      let sequence = 1
      while (existingTitles.has(`分组${sequence}`)) sequence++
      const tabIds: [number, ...number[]] = [looseTabs[0].id!, ...looseTabs.slice(1).map(t => t.id!)]
      const groupId = await chrome.tabs.group({ tabIds, createProperties: { windowId } })
      await chrome.tabGroups.update(groupId, { title: `分组${sequence}`, collapsed: true })
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
