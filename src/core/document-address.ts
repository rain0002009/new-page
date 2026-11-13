export function documentUrl(source: { note: string; source: string } | { url: string } | { local: string }) {
  return chrome.runtime.getURL('document/index.html') + '?' + new URLSearchParams(source)
}
export function isMarkdownUrl(value: string) {
  try { const url = new URL(value); return ['http:', 'https:', 'file:'].includes(url.protocol) && /\.(md|markdown)$/i.test(url.pathname) } catch { return false }
}
