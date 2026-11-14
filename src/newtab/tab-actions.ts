import type { OpenTab } from './open-tabs'

// A saved tab can be retried without re-saving it; identities and the original
// URL/window guard remain fixed until closing succeeds or the page changes.
export async function closeSavedTabs(tabs: OpenTab[], pending: Map<number, OpenTab>, notify: (message: string) => void) {
  const failed: string[] = []
  for (const tab of tabs) {
    const snapshot = pending.get(tab.tabId) ?? tab
    try {
      let current: chrome.tabs.Tab
      try { current = await chrome.tabs.get(snapshot.tabId) }
      catch (cause) { if (cause instanceof Error && /No tab with id/i.test(cause.message)) { pending.delete(snapshot.tabId); continue }; throw cause }
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
