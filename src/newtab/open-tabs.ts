import type { LinkInput } from '../core/model'

export type OpenTab = LinkInput & { tabId: number }

export function tabLink(tab: OpenTab): LinkInput {
  return { title: tab.title, url: tab.url, icon: tab.icon }
}

export async function closeCollectedTab(tab: OpenTab, notify: (message: string) => void) {
  try {
    const current = await chrome.tabs.get(tab.tabId)
    if ((current.pendingUrl || current.url) !== tab.url) {
      notify('收藏已保存，原标签页已变化，已保留当前页面')
      return
    }
    await chrome.tabs.remove(tab.tabId)
  } catch (error) {
    if (error instanceof Error && /No tab with id/i.test(error.message)) return
    notify('收藏已保存，无法关闭原标签页，请手动关闭')
  }
}
