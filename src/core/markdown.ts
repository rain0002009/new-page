export { documentUrl, isMarkdownUrl } from './document-address'
export function downloadMarkdown(title: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = (title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '新笔记').replace(/\.(md|markdown)$/i, '') + '.md'
  anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkFrontmatter from 'remark-frontmatter'

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkFrontmatter, ['yaml', 'toml'])
type Node = { type: string; value?: string; depth?: number; children?: Node[] }
const textOf = (node: Node): string => ['image', 'html', 'code', 'yaml', 'toml', 'definition', 'thematicBreak'].includes(node.type) ? '' : node.value ?? node.children?.map(textOf).join('') ?? ''
export function markdownDescription(body: string) {
  const visit = (node: Node): string => {
    if (['heading', 'paragraph'].includes(node.type)) return textOf(node).replace(/\s+/g, ' ').trim()
    if (['code', 'yaml', 'toml', 'html'].includes(node.type)) return ''
    for (const child of node.children ?? []) { const text = visit(child); if (text) return text }
    return ''
  }
  return visit(parser.parse(body) as Node)
}
export function markdownOutline(body: string) {
  const result: { title: string; depth: number }[] = []
  const visit = (node: Node) => { if (node.type === 'heading') result.push({ title: textOf(node), depth: node.depth! }); node.children?.forEach(visit) }
  visit(parser.parse(body) as Node)
  return result
}
