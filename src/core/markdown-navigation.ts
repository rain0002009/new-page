import { documentUrl, isMarkdownUrl } from './document-address'

const bypass = new Map<number, string>()
const withoutHash = (url: string) => { const parsed = new URL(url); parsed.hash = ''; return parsed.href }

async function takeOver(tabId: number, url: string) {
  if (bypass.get(tabId) === withoutHash(url)) return
  const values = await chrome.storage.local.get('markdownTakeover')
  if (values.markdownTakeover === false) return
  const tab = await chrome.tabs.get(tabId)
  const current = tab.pendingUrl ?? tab.url
  if (!current || withoutHash(current) !== withoutHash(url)) return
  await chrome.tabs.update(tabId, { url: documentUrl({ url: current }) })
}

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
  // Local files have no HTTP response headers; retain their navigation path.
  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return
    if (bypass.get(details.tabId) === withoutHash(details.url)) return
    if (!details.url.startsWith(chrome.runtime.getURL(''))) bypass.delete(details.tabId)
    if (!details.url.startsWith('file:') || !isMarkdownUrl(details.url)) return
    void takeOver(details.tabId, details.url).catch(() => {})
  })
  // A .md URL may serve an HTML page (for example GitHub's file viewer).
  // Wait for the actual response type before replacing a remote navigation.
  chrome.webRequest.onHeadersReceived.addListener(details => {
    if (details.statusCode < 200 || details.statusCode >= 300 || !isMarkdownUrl(details.url)) return
    const type = details.responseHeaders?.find(header => header.name.toLowerCase() === 'content-type')?.value?.split(';')[0].trim().toLowerCase()
    if (!type || !['text/plain', 'text/markdown', 'text/x-markdown'].includes(type)) return
    void takeOver(details.tabId, details.url).catch(() => {})
  }, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] }, ['responseHeaders'])
  chrome.tabs.onRemoved.addListener(tabId => {
    bypass.delete(tabId)
  })
}
