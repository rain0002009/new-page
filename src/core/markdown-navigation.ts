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
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.type !== 'local-markdown-navigation' || sender.id !== chrome.runtime.id || sender.frameId !== 0 || sender.tab?.id === undefined || !sender.url?.startsWith('file:') || !isMarkdownUrl(sender.url)) return false
    const url = sender.url, tabId = sender.tab.id
    void chrome.storage.local.get('markdownTakeover').then(values => {
      respond({ reader: values.markdownTakeover !== false && bypass.get(tabId) !== withoutHash(url) ? documentUrl({ url }) : undefined })
    }, () => respond({}))
    return true
  })
  // Without file access Chrome cannot inject the early script. Keep the
  // existing reader entry so it can explain how to enable file access.
  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId !== 0) return
    if (bypass.get(details.tabId) === withoutHash(details.url)) return
    if (!details.url.startsWith(chrome.runtime.getURL(''))) bypass.delete(details.tabId)
    if (!details.url.startsWith('file:') || !isMarkdownUrl(details.url)) return
    void chrome.extension.isAllowedFileSchemeAccess().then(allowed => {
      if (!allowed) return takeOver(details.tabId, details.url)
    }).catch(() => {})
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
