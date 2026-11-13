import { documentUrl, isMarkdownUrl } from './document-address'

const bypass = new Map<number, string>()
const withoutHash = (url: string) => { const parsed = new URL(url); parsed.hash = ''; return parsed.href }

export async function configureMarkdownNavigation(value: boolean) {
  await chrome.storage.local.set({ markdownTakeover: value })
}
export async function openOriginalMarkdown(url: string, tabId?: number) {
  if (tabId === undefined || !isMarkdownUrl(url)) throw new Error('原网页地址无效')
  const original = withoutHash(url)
  bypass.set(tabId, original)
  await chrome.tabs.update(tabId, { url })
}
export function startMarkdownNavigation() {
  // Observe only top-level navigations; this also handles file URLs without
  // modifying iframe, image, or fetch requests in ordinary websites.
  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return
    if (bypass.get(details.tabId) === withoutHash(details.url)) return
    if (!details.url.startsWith(chrome.runtime.getURL(''))) bypass.delete(details.tabId)
    if (!isMarkdownUrl(details.url)) return
    void chrome.storage.local.get('markdownTakeover').then(async values => {
      if (values.markdownTakeover === false) return
      const tab = await chrome.tabs.get(details.tabId)
      if (![tab.pendingUrl, tab.url].includes(details.url)) return
      await chrome.tabs.update(details.tabId, { url: documentUrl({ url: details.url }) })
    }).catch(() => {})
  })
  chrome.tabs.onRemoved.addListener(tabId => {
    bypass.delete(tabId)
  })
}
