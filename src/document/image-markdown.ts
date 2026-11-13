import { $remark } from '@milkdown/kit/utils'
import type { MarkdownNode } from '@milkdown/kit/transformer'

// Crepe interprets every standalone image's alt as a resize ratio. Restore
// ordinary images after that transform so editing preserves their alt and title.
export const preserveStandardImages = $remark('preserve-standard-images', () => () => tree => {
  function restore(node: MarkdownNode) {
    node.children = node.children?.map(child => {
      if (child.type === 'image-block' && !/^\d+\.\d{2}$/.test(String(child.alt ?? ''))) {
        return { type: 'paragraph', children: [{ ...child, type: 'image' }] }
      }
      restore(child)
      return child
    })
  }
  restore(tree as MarkdownNode)
})
