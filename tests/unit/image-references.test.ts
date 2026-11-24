import { test, expect } from 'vitest'
import { imageReferences, normalizeImageUrl, removedImageReferences } from '../../src/core/image-references'

test('图片引用规范化协议、主机与片段，保留查询参数并去重', () => {
  expect([...imageReferences('![a](HTTPS://EXAMPLE.COM:443/a.png?size=2#one)\n\n![b](https://example.com/a.png?size=2#two)')]).toEqual(['https://example.com/a.png?size=2'])
  for (const value of ['data:image/png;base64,test', 'javascript:alert(1)', 'file:///test.png', '/relative.png', 'not a URL']) {
    expect(normalizeImageUrl(value)).toBeNull()
  }
})

test('图片引用支持完整、折叠与简写引用，使用第一个定义', () => {
  const body = '![first][Shared Image]\n\n![shared image][]\n\n![shared image]\n\n[Shared Image]: https://example.test/a.png#original\n[shared image]: https://example.test/ignored.png\n[unused]: https://example.test/unused.png'
  expect([...imageReferences(body)]).toEqual(['https://example.test/a.png'])
})

test('代码、链接、未使用定义和前置配置不会成为图片引用', () => {
  const body = '---\nimage: https://example.test/yaml.png\n---\n\n```md\n![fenced](https://example.test/fenced.png)\n<img src="https://example.test/fenced-html.png">\n```\n\n`![inline](https://example.test/inline.png)`\n\n    ![indented](https://example.test/indented.png)\n\n[link](https://example.test/link.png)\n\n<https://example.test/autolink.png>\n\n[unused]: https://example.test/unused.png'
  expect([...imageReferences(body)]).toEqual([])
})

test('HTML 图片支持引号、无引号、大小写和实体，忽略伪属性、注释与脚本文本', () => {
  const body = `<IMG alt="a > b" SRC="https://example.test/a.png?x=1&amp;y=2#view">\n\n<img src='https://example.test/b&#46;png'>\n\n<div>\n<img src=https://example.test/c.png>\n</div>\n\n<img data-src="https://example.test/not-src.png" title='src="https://example.test/not-attribute.png"'>\n\n<!-- <img src="https://example.test/comment.png"> -->\n\n<script>const x = '<img src="https://example.test/script.png">'</script>`
  expect([...imageReferences(body)]).toEqual(['https://example.test/a.png?x=1&y=2', 'https://example.test/b.png', 'https://example.test/c.png'])
})

test('移除差集只在最后一个等价图片引用消失后返回地址', () => {
  const before = '![one](https://example.test/a.png#one)\n\n![two](https://example.test/a.png#two)\n\n![other](https://example.test/b.png)'
  expect(removedImageReferences(before, '![retained](https://example.test/a.png#new)')).toEqual(['https://example.test/b.png'])
  expect(removedImageReferences(before, '[ordinary link](https://example.test/a.png)')).toEqual(['https://example.test/a.png', 'https://example.test/b.png'])
})

test('HTML 完整命名实体与数字实体保持图片地址等价', () => {
  expect([...imageReferences('<img src="https&colon;//example.test/a&#x2e;png?x=1&amp;y=2">')]).toEqual(['https://example.test/a.png?x=1&y=2'])
})
