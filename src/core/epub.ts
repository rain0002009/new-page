import { unzipSync, strFromU8 } from 'fflate'

export const isEpubName = (name: string) => /\.epub$/i.test(name)
export function droppedEpubFiles(transfer: DataTransfer | null | undefined): File[] {
  return transfer ? Array.from(transfer.files || []).filter(file => isEpubName(file.name)) : []
}

export type EpubChapter = {
  index: number
  id: string
  href: string
  title: string
  weight: number
  mediaType: string
}

export type EpubTocItem = {
  id: string
  title: string
  href: string
  chapterIndex: number
  fragment?: string
  children: EpubTocItem[]
}

export type ParsedEpub = {
  title: string
  author?: string
  chapters: EpubChapter[]
  toc: EpubTocItem[]
  readEntry: (path: string) => Uint8Array | undefined
  readText: (path: string) => string | undefined
  resolveHref: (baseHref: string, relativeHref: string) => { path: string; fragment?: string }
}

const xmlEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : full
    }
    return xmlEntities[entity] ?? full
  })
}

function stripTags(xml: string): string {
  return decodeXmlEntities(xml.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '')
  }
  return attrs
}

export function normalizeZipPath(path: string): string {
  const parts: string[] = []
  for (const raw of path.replace(/\\/g, '/').split('/')) {
    if (!raw || raw === '.') continue
    if (raw === '..') parts.pop()
    else parts.push(raw)
  }
  return parts.join('/')
}

export function resolveEpubHref(baseHref: string, relativeHref: string): { path: string; fragment?: string } {
  const hashIndex = relativeHref.indexOf('#')
  const rawPath = hashIndex >= 0 ? relativeHref.slice(0, hashIndex) : relativeHref
  const fragment = hashIndex >= 0 ? relativeHref.slice(hashIndex + 1) || undefined : undefined
  let decoded = rawPath
  try { decoded = decodeURIComponent(rawPath) } catch { /* Keep raw path when malformed percent-encoding appears. */ }
  const clean = decoded.split('?')[0]
  if (!clean) return { path: normalizeZipPath(baseHref), fragment }
  if (clean.startsWith('/')) return { path: normalizeZipPath(clean.slice(1)), fragment }
  const baseDir = baseHref.includes('/') ? baseHref.slice(0, baseHref.lastIndexOf('/') + 1) : ''
  return { path: normalizeZipPath(baseDir + clean), fragment }
}

function findMatchingTagEnd(source: string, tagName: string, searchFrom: number): number {
  const openRe = new RegExp(`<${tagName}\\b[^>]*>`, 'gi')
  const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi')
  let depth = 1
  let pos = searchFrom
  while (depth > 0) {
    openRe.lastIndex = pos
    closeRe.lastIndex = pos
    const nextOpen = openRe.exec(source)
    const nextClose = closeRe.exec(source)
    if (!nextClose) return -1
    if (nextOpen && nextOpen.index < nextClose.index) {
      if (!nextOpen[0].endsWith('/>')) depth++
      pos = openRe.lastIndex
    } else {
      depth--
      if (depth === 0) return nextClose.index
      pos = closeRe.lastIndex
    }
  }
  return -1
}

function lookupChapterIndex(chapterByPath: Map<string, number>, chapterByLowerPath: Map<string, number>, path: string): number {
  return chapterByPath.get(path) ?? chapterByLowerPath.get(path.toLowerCase()) ?? 0
}

function parseNcxNavPoints(xml: string, ncxHref: string, chapterByPath: Map<string, number>, chapterByLowerPath: Map<string, number>, counter: { value: number }): EpubTocItem[] {
  const items: EpubTocItem[] = []
  const openRe = /<navPoint\b([^>]*)>/gi
  let pos = 0
  while (pos < xml.length) {
    openRe.lastIndex = pos
    const match = openRe.exec(xml)
    if (!match) break
    const bodyStart = openRe.lastIndex
    const bodyEnd = findMatchingTagEnd(xml, 'navPoint', bodyStart)
    if (bodyEnd < 0) break
    const inner = xml.slice(bodyStart, bodyEnd)
    const firstNested = inner.search(/<navPoint\b/i)
    const ownHead = firstNested >= 0 ? inner.slice(0, firstNested) : inner
    const labelMatch = /<navLabel\b[^>]*>[\s\S]*?<text\b[^>]*>([\s\S]*?)<\/text>[\s\S]*?<\/navLabel>/i.exec(ownHead)
    const contentMatch = /<content\b([^>]*)\/?>/i.exec(ownHead)
    const src = contentMatch ? parseAttributes(contentMatch[1]).src ?? '' : ''
    const resolved = src ? resolveEpubHref(ncxHref, src) : { path: '' }
    const chapterIndex = lookupChapterIndex(chapterByPath, chapterByLowerPath, resolved.path)
    const children = firstNested >= 0 ? parseNcxNavPoints(inner.slice(firstNested), ncxHref, chapterByPath, chapterByLowerPath, counter) : []
    items.push({
      id: `toc-${counter.value++}`,
      title: labelMatch ? stripTags(labelMatch[1]) || '无标题章节' : '无标题章节',
      href: resolved.path,
      fragment: resolved.fragment,
      chapterIndex,
      children,
    })
    pos = bodyEnd + '</navPoint>'.length
  }
  return items
}

function parseNavList(olInner: string, navHref: string, chapterByPath: Map<string, number>, chapterByLowerPath: Map<string, number>, counter: { value: number }): EpubTocItem[] {
  const items: EpubTocItem[] = []
  const liRe = /<li\b[^>]*>/gi
  let pos = 0
  while (pos < olInner.length) {
    liRe.lastIndex = pos
    const match = liRe.exec(olInner)
    if (!match) break
    const bodyStart = liRe.lastIndex
    const bodyEnd = findMatchingTagEnd(olInner, 'li', bodyStart)
    if (bodyEnd < 0) break
    const inner = olInner.slice(bodyStart, bodyEnd)
    const subOlStart = inner.search(/<ol\b/i)
    const ownPart = subOlStart >= 0 ? inner.slice(0, subOlStart) : inner
    const anchorMatch = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(ownPart)
    let children: EpubTocItem[] = []
    if (subOlStart >= 0) {
      const subTagMatch = /<ol\b[^>]*>/i.exec(inner.slice(subOlStart))
      if (subTagMatch) {
        const olStart = subOlStart + subTagMatch.index + subTagMatch[0].length
        const olEnd = findMatchingTagEnd(inner, 'ol', olStart)
        if (olEnd >= 0) children = parseNavList(inner.slice(olStart, olEnd), navHref, chapterByPath, chapterByLowerPath, counter)
      }
    }
    if (anchorMatch) {
      const href = parseAttributes(anchorMatch[1]).href ?? ''
      const resolved = href ? resolveEpubHref(navHref, href) : { path: '' }
      items.push({
        id: `toc-${counter.value++}`,
        title: stripTags(anchorMatch[2]) || '无标题章节',
        href: resolved.path,
        fragment: resolved.fragment,
        chapterIndex: lookupChapterIndex(chapterByPath, chapterByLowerPath, resolved.path),
        children,
      })
    } else if (children.length) {
      const headingText = stripTags(ownPart)
      if (headingText) {
        items.push({
          id: `toc-${counter.value++}`,
          title: headingText,
          href: children[0].href,
          fragment: children[0].fragment,
          chapterIndex: children[0].chapterIndex,
          children,
        })
      } else {
        items.push(...children)
      }
    }
    pos = bodyEnd + '</li>'.length
  }
  return items
}

function parseNavXhtml(xhtml: string, navHref: string, chapterByPath: Map<string, number>, chapterByLowerPath: Map<string, number>): EpubTocItem[] {
  const navRe = /<nav\b([^>]*)>/gi
  let selectedInner = ''
  let fallbackInner = ''
  let match: RegExpExecArray | null
  while ((match = navRe.exec(xhtml)) !== null) {
    const start = navRe.lastIndex
    const end = findMatchingTagEnd(xhtml, 'nav', start)
    if (end < 0) continue
    const inner = xhtml.slice(start, end)
    if (!fallbackInner) fallbackInner = inner
    const attrs = parseAttributes(match[1])
    if (/\btoc\b/i.test(attrs['epub:type'] ?? '') || /\btoc\b/i.test(attrs.role ?? '')) {
      selectedInner = inner
      break
    }
  }
  const target = selectedInner || fallbackInner
  if (!target) return []
  const olMatch = /<ol\b[^>]*>/i.exec(target)
  if (!olMatch) return []
  const olStart = olMatch.index + olMatch[0].length
  const olEnd = findMatchingTagEnd(target, 'ol', olStart)
  if (olEnd < 0) return []
  return parseNavList(target.slice(olStart, olEnd), navHref, chapterByPath, chapterByLowerPath, { value: 1 })
}

function applyTocTitlesToChapters(toc: EpubTocItem[], chapters: EpubChapter[]) {
  const visit = (items: EpubTocItem[]) => {
    for (const item of items) {
      const chapter = chapters[item.chapterIndex]
      if (chapter && /^第 \d+ 章$/.test(chapter.title) && item.title) {
        chapter.title = item.title
      }
      visit(item.children)
    }
  }
  visit(toc)
}

export function parseEpub(bytes: Uint8Array, fallbackFileName = '未命名电子书.epub'): ParsedEpub {
  let archive: Record<string, Uint8Array>
  try {
    archive = unzipSync(bytes)
  } catch {
    throw new Error('无法解析此 EPUB 文件，请确认文件未损坏')
  }

  const normalizedArchive = new Map<string, Uint8Array>()
  const lowerArchive = new Map<string, Uint8Array>()
  for (const [rawPath, entry] of Object.entries(archive)) {
    const clean = normalizeZipPath(rawPath)
    normalizedArchive.set(clean, entry)
    lowerArchive.set(clean.toLowerCase(), entry)
  }

  const readEntry = (path: string) => {
    const clean = normalizeZipPath(path)
    return normalizedArchive.get(clean) ?? lowerArchive.get(clean.toLowerCase())
  }
  const readText = (path: string) => {
    const entry = readEntry(path)
    return entry ? strFromU8(entry) : undefined
  }

  const containerXml = readText('META-INF/container.xml')
  let opfPath = ''
  if (containerXml) {
    const rootfileMatch = /<rootfile\b([^>]*)/i.exec(containerXml)
    if (rootfileMatch) opfPath = normalizeZipPath(parseAttributes(rootfileMatch[1])['full-path'] ?? '')
  }
  if (!opfPath) {
    opfPath = [...normalizedArchive.keys()].find(path => /\.opf$/i.test(path)) ?? ''
  }
  const opfXml = opfPath ? readText(opfPath) : undefined
  if (!opfXml) throw new Error('EPUB 缺少内容索引（OPF），无法打开阅读')

  const fallbackTitle = fallbackFileName.replace(/\.epub$/i, '').trim() || '未命名电子书'
  const titleMatch = /<(?:dc:)?title\b[^>]*>([\s\S]*?)<\/(?:dc:)?title>/i.exec(opfXml)
  const title = (titleMatch ? stripTags(titleMatch[1]) : '') || fallbackTitle
  const authorMatch = /<(?:dc:)?creator\b[^>]*>([\s\S]*?)<\/(?:dc:)?creator>/i.exec(opfXml)
  const author = authorMatch ? stripTags(authorMatch[1]) || undefined : undefined

  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>()
  const itemRe = /<item\b([^>]*)\/?>/gi
  let itemMatch: RegExpExecArray | null
  while ((itemMatch = itemRe.exec(opfXml)) !== null) {
    const attrs = parseAttributes(itemMatch[1])
    if (!attrs.id || !attrs.href) continue
    manifest.set(attrs.id, {
      href: resolveEpubHref(opfPath, attrs.href).path,
      mediaType: attrs['media-type'] ?? 'application/xhtml+xml',
      properties: attrs.properties ?? '',
    })
  }

  const spineMatch = /<spine\b([^>]*)>([\s\S]*?)<\/spine>/i.exec(opfXml)
  const spineAttrs = spineMatch ? parseAttributes(spineMatch[1]) : {}
  const spineBody = spineMatch?.[2] ?? ''
  const chapters: EpubChapter[] = []
  const chapterByPath = new Map<string, number>()
  const chapterByLowerPath = new Map<string, number>()

  const itemrefRe = /<itemref\b([^>]*)\/?>/gi
  let refMatch: RegExpExecArray | null
  while ((refMatch = itemrefRe.exec(spineBody)) !== null) {
    const idref = parseAttributes(refMatch[1]).idref
    const item = idref ? manifest.get(idref) : undefined
    if (!item) continue
    const content = readEntry(item.href)
    if (!content) continue
    const index = chapters.length
    chapterByPath.set(item.href, index)
    chapterByLowerPath.set(item.href.toLowerCase(), index)
    chapters.push({
      index,
      id: idref,
      href: item.href,
      title: `第 ${index + 1} 章`,
      weight: Math.max(1, content.byteLength),
      mediaType: item.mediaType,
    })
  }

  if (!chapters.length) throw new Error('EPUB 中未找到可阅读的章节内容')

  let toc: EpubTocItem[] = []
  const navItem = [...manifest.values()].find(entry => /\bnav\b/i.test(entry.properties))
  if (navItem) {
    const navXml = readText(navItem.href)
    if (navXml) toc = parseNavXhtml(navXml, navItem.href, chapterByPath, chapterByLowerPath)
  }
  if (!toc.length) {
    const ncxItem = (spineAttrs.toc ? manifest.get(spineAttrs.toc) : undefined)
      ?? [...manifest.values()].find(entry => entry.mediaType === 'application/x-dtbncx+xml')
    if (ncxItem) {
      const ncxXml = readText(ncxItem.href)
      if (ncxXml) toc = parseNcxNavPoints(ncxXml, ncxItem.href, chapterByPath, chapterByLowerPath, { value: 1 })
    }
  }
  if (!toc.length) {
    toc = chapters.map(chapter => ({
      id: `toc-${chapter.index + 1}`,
      title: chapter.title,
      href: chapter.href,
      chapterIndex: chapter.index,
      children: [],
    }))
  } else {
    applyTocTitlesToChapters(toc, chapters)
  }

  return {
    title,
    author,
    chapters,
    toc,
    readEntry,
    readText,
    resolveHref: resolveEpubHref,
  }
}

export function computeReadingProgress(chapters: { weight: number }[], chapterIndex: number, scrollRatio: number): number {
  if (!chapters.length) return 0
  const index = Math.max(0, Math.min(chapters.length - 1, Math.floor(chapterIndex)))
  const ratio = Math.max(0, Math.min(1, Number.isFinite(scrollRatio) ? scrollRatio : 0))
  if (index === chapters.length - 1 && ratio >= 0.99) return 100
  const totalWeight = chapters.reduce((sum, chapter) => sum + Math.max(1, chapter.weight), 0)
  if (totalWeight <= 0) return 0
  const before = chapters.slice(0, index).reduce((sum, chapter) => sum + Math.max(1, chapter.weight), 0)
  const current = Math.max(1, chapters[index].weight) * ratio
  return Math.max(0, Math.min(100, Math.round(((before + current) / totalWeight) * 100)))
}
