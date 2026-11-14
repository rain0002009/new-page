import { isMarkdownUrl } from '../core/document-address'

// File navigation can paint before the service worker has read the preference.
// Hide only Markdown documents while that decision is pending.
if (window === window.top && location.protocol === 'file:' && isMarkdownUrl(location.href)) {
  const cover = document.createElement('style')
  cover.textContent = ':root { visibility: hidden !important; }'
  document.documentElement.append(cover)
  const timeout = setTimeout(() => cover.remove(), 5000)
  void chrome.runtime.sendMessage({ type: 'local-markdown-navigation' }).then((result: { reader?: string } | undefined) => {
    if (result?.reader) location.replace(result.reader)
    else cover.remove()
  }).catch(() => cover.remove()).finally(() => clearTimeout(timeout))
}
