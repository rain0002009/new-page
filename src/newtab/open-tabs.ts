import type { LinkInput } from '../core/model'

export type OpenTab = LinkInput & { tabId: number; windowId: number; pinned: boolean; index: number; groupId: number }

export function collectionTitle(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `收藏 ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function tabLink(tab: OpenTab): LinkInput {
  return { title: tab.title, url: tab.url, icon: tab.icon }
}

export function canSortTabs(source: OpenTab, target: OpenTab) {
  return source.windowId === target.windowId && source.pinned === target.pinned
}

export async function moveOpenTab(source: OpenTab, target: OpenTab, notify: (message: string) => void) {
  try {
    const [current, destination] = await Promise.all([chrome.tabs.get(source.tabId), chrome.tabs.get(target.tabId)])
    if (!canSortTabs(source, target) || current.windowId !== source.windowId || destination.windowId !== target.windowId ||
        current.pinned !== source.pinned || destination.pinned !== target.pinned || current.index !== source.index || destination.index !== target.index) {
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
