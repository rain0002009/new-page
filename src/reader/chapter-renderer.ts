import type { ParsedEpub } from '../core/epub'

const mimeByExt: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
  bmp: 'image/bmp',
}

function inferImageMime(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return mimeByExt[ext] ?? 'application/octet-stream'
}

const blockedTags = new Set(['script', 'noscript', 'iframe', 'object', 'embed', 'applet', 'base', 'meta', 'link', 'style', 'form'])

export function renderChapterHtml(parsed: ParsedEpub, chapterHref: string): { html: string; objectUrls: string[] } {
  const raw = parsed.readText(chapterHref)
  if (!raw) return { html: '<p>章节内容为空或无法读取。</p>', objectUrls: [] }

  const parser = new DOMParser()
  let doc = parser.parseFromString(raw, 'application/xhtml+xml')
  if (doc.querySelector('parsererror')) {
    doc = parser.parseFromString(raw, 'text/html')
  }

  const root = doc.body ?? doc.documentElement
  if (!root) return { html: '<p>章节内容为空。</p>', objectUrls: [] }

  const objectUrls: string[] = []
  const blobCache = new Map<string, string>()

  const toBlobUrl = (relative: string): string | undefined => {
    if (/^(data:image\/|blob:)/i.test(relative)) return relative
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relative)) return undefined
    const resolved = parsed.resolveHref(chapterHref, relative)
    const cached = blobCache.get(resolved.path)
    if (cached) return cached
    const bytes = parsed.readEntry(resolved.path)
    if (!bytes) return undefined
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: inferImageMime(resolved.path) }))
    blobCache.set(resolved.path, url)
    objectUrls.push(url)
    return url
  }

  const walk = (node: Element) => {
    for (const child of Array.from(node.children)) {
      const tag = child.localName.toLowerCase()
      if (blockedTags.has(tag)) {
        child.remove()
        continue
      }

      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase()
        if (name.startsWith('on')) {
          child.removeAttribute(attr.name)
          continue
        }
        if (name === 'style') {
          // Strip typography styles from embedded markup so global reader font size, weight, and line height stay authoritative.
          const cleaned = attr.value
            .replace(/(?:^|;)\s*(?:font-size|font-weight|line-height|font-family|color|background(?:-color)?|margin(?:-left|-right)?|width|max-width)\s*:[^;]*/gi, '')
            .replace(/^;+|;+$/g, '')
            .trim()
          if (cleaned) child.setAttribute('style', cleaned)
          else child.removeAttribute('style')
        }
      }

      if (tag === 'img') {
        const src = child.getAttribute('src')
        const mapped = src ? toBlobUrl(src) : undefined
        if (mapped) child.setAttribute('src', mapped)
        else child.removeAttribute('src')
      } else if (tag === 'image') {
        const href = child.getAttribute('href') ?? child.getAttribute('xlink:href')
        const mapped = href ? toBlobUrl(href) : undefined
        if (mapped) {
          child.setAttribute('href', mapped)
          child.removeAttribute('xlink:href')
        }
      } else if (tag === 'a') {
        const href = child.getAttribute('href') ?? ''
        if (/^javascript:/i.test(href.trim())) {
          child.removeAttribute('href')
        } else if (/^https?:/i.test(href)) {
          child.setAttribute('target', '_blank')
          child.setAttribute('rel', 'noreferrer')
        } else if (href) {
          child.setAttribute('data-epub-href', href)
          child.setAttribute('href', '#')
        }
      }

      walk(child)
    }
  }

  walk(root)
  return { html: root.innerHTML || '<p>章节内容为空。</p>', objectUrls }
}
