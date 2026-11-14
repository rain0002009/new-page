import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])
type Node = { type: string; url?: string; identifier?: string; value?: string; children?: Node[] }

export function normalizeImageUrl(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

function decodeHtmlAttribute(value: string) {
  return value.replace(/&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]+);/g, entity => {
    // Reuse CommonMark's complete entity table instead of keeping a partial
    // HTML entity decoder that could miss an existing image reference.
    const tree = parser.parse(entity) as Node
    return tree.children?.[0]?.children?.[0]?.value ?? entity
  })
}

function htmlImageUrls(html: string) {
  const result: string[] = []
  // Match complete quoted attributes so data-src and text inside another
  // attribute cannot masquerade as an image source. Never execute HTML.
  const tags = /<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)|<img\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi
  for (const tag of html.matchAll(tags)) {
    if (tag[2] === undefined) continue
    const attributes = /([^\s=/'"<>`]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    for (const attribute of tag[2].matchAll(attributes)) {
      if (attribute[1].toLowerCase() !== 'src') continue
      result.push(decodeHtmlAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''))
      break
    }
  }
  return result
}

export function imageReferences(markdown: string): Set<string> {
  const tree = parser.parse(markdown) as Node
  const definitions = new Map<string, string>()
  const identifier = (value: string) => value.replace(/\s+/g, ' ').trim().toUpperCase()
  const visit = (node: Node, work: (node: Node) => void) => {
    work(node)
    node.children?.forEach(child => visit(child, work))
  }
  visit(tree, node => {
    if (node.type === 'definition' && node.identifier && node.url && !definitions.has(identifier(node.identifier))) {
      definitions.set(identifier(node.identifier), node.url)
    }
  })
  const result = new Set<string>()
  const add = (value: string | undefined) => {
    const normalized = value === undefined ? null : normalizeImageUrl(value)
    if (normalized) result.add(normalized)
  }
  visit(tree, node => {
    if (node.type === 'image') add(node.url)
    if (node.type === 'imageReference' && node.identifier) add(definitions.get(identifier(node.identifier)))
    if (node.type === 'html' && node.value) htmlImageUrls(node.value).forEach(add)
  })
  return result
}

export function removedImageReferences(before: string, after: string): string[] {
  const remaining = imageReferences(after)
  return [...imageReferences(before)].filter(url => !remaining.has(url))
}
