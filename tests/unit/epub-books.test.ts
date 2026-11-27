import { createHash } from 'node:crypto'
import { zipSync, strToU8 } from 'fflate'
import { describe, expect, test, afterEach } from 'vitest'
import { apply, children, createDocument, filterTagSelection, prune, readDocument, tagUsages } from '../../src/core/model'
import { merge } from '../../src/core/merge'
import { computeReadingProgress, parseEpub } from '../../src/core/epub'
import { QuarkClient, MAX_QUARK_EPUB_BYTES } from '../../src/core/quark/client'

function buildSampleEpub(options?: { title?: string; author?: string; useNav?: boolean }) {
  const title = options?.title ?? '沙丘编年史'
  const author = options?.author ?? '弗兰克·赫伯特'
  const useNav = options?.useNav ?? false

  const files: Record<string, Uint8Array> = {
    'mimetype': strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0" encoding="utf-8"?>' +
      '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
      '<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>' +
      '</container>',
    ),
    'OEBPS/content.opf': strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
      <package xmlns="http://www.idpf.org/2007/opf" version="${useNav ? '3.0' : '2.0'}">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
          <dc:title>${title}</dc:title>
          <dc:creator>${author}</dc:creator>
        </metadata>
        <manifest>
          <item id="ch1" href="Text/chapter1.xhtml" media-type="application/xhtml+xml"/>
          <item id="ch2" href="Text/chapter2.xhtml" media-type="application/xhtml+xml"/>
          <item id="img1" href="Images/cover.png" media-type="image/png"/>
          ${useNav
            ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
            : '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'}
        </manifest>
        <spine ${useNav ? '' : 'toc="ncx"'}>
          <itemref idref="ch1"/>
          <itemref idref="ch2"/>
        </spine>
      </package>`,
    ),
    'OEBPS/Text/chapter1.xhtml': strToU8(
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章 启程</h1><p>内容一</p><img src="../Images/cover.png"/></body></html>',
    ),
    'OEBPS/Text/chapter2.xhtml': strToU8(
      '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1 id="sec2">第二章 沙海</h1><p>内容二，更长的段落内容用于拉开权重</p></body></html>',
    ),
    'OEBPS/Images/cover.png': new Uint8Array([137, 80, 78, 71]),
  }

  if (useNav) {
    files['OEBPS/nav.xhtml'] = strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
      <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
        <body>
          <nav epub:type="toc">
            <ol>
              <li><a href="Text/chapter1.xhtml">第一章 启程</a></li>
              <li><a href="Text/CHAPTER2.xhtml#sec2">第二章 沙海</a>
                <ol><li><a href="Text/chapter2.xhtml#sub">2.1 沙虫</a></li></ol>
              </li>
            </ol>
          </nav>
        </body>
      </html>`,
    )
  } else {
    files['OEBPS/toc.ncx'] = strToU8(
      `<?xml version="1.0" encoding="utf-8"?>
      <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
        <navMap>
          <navPoint id="p1" playOrder="1"><navLabel><text>第一章 启程</text></navLabel><content src="Text/chapter1.xhtml"/></navPoint>
          <navPoint id="p2" playOrder="2"><navLabel><text>第二章 沙海</text></navLabel><content src="Text/chapter2.xhtml#sec2"/></navPoint>
        </navMap>
      </ncx>`,
    )
  }
  return zipSync(files)
}

const originalFetch = globalThis.fetch
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
  else Reflect.deleteProperty(globalThis, 'chrome')
})

describe('Book 领域模型与删除/合并契约', () => {
  test('支持创建电子书、更新阅读进度、打标签、筛选以及单本直删 / 随块入回收站', () => {
    let doc = createDocument('Rain')
    const space = children(doc, null).find(e => e.kind === 'space')!
    const collection = children(doc, space.id).find(e => e.kind === 'collection')!

    doc = apply(doc, {
      type: 'add-book',
      parentId: collection.id,
      id: 'book-1',
      title: '沙丘',
      storage: 'local',
      fileName: 'dune.epub',
      fileSize: 1024,
    })
    doc = apply(doc, {
      type: 'edit',
      id: 'book-1',
      patch: { progress: 42, chapterIndex: 1, scrollRatio: 0.5 },
    })

    const book = doc.entities['book-1']
    expect(book.kind).toBe('book')
    if (book.kind !== 'book') throw new Error('expected book')
    expect(book.progress).toBe(42)
    expect(book.chapterIndex).toBe(1)
    expect(book.scrollRatio).toBe(0.5)

    // 标签与筛选
    doc = apply(doc, { type: 'add-tag', id: 'tag-scifi', name: '科幻', color: 'blue' })
    doc = apply(doc, { type: 'set-tags', id: 'book-1', tagIds: ['tag-scifi'] })
    expect(tagUsages(doc, 'tag-scifi')).toHaveLength(1)
    expect(filterTagSelection(doc, space.id, ['tag-scifi']).get(collection.id)?.map(i => i.id)).toEqual(['book-1'])

    // 单本删除绕过回收站直接永久清除（ADR 0004 一致语义）
    const directDeleted = apply(doc, { type: 'delete', id: 'book-1' })
    expect(directDeleted.entities['book-1'].purged).toBe(true)

    // 随收藏块删除则进入回收站且可恢复
    const collectionDeleted = apply(doc, { type: 'delete', id: collection.id })
    expect(collectionDeleted.entities['book-1'].deletedAt).not.toBeNull()
    expect(collectionDeleted.entities['book-1'].purged).toBe(false)
    const restored = apply(collectionDeleted, { type: 'restore', id: collection.id })
    expect(restored.entities['book-1'].deletedAt).toBeNull()
    expect(readDocument(restored).entities['book-1'].title).toBe('沙丘')

    // 30 天自动清理应清除到期回收站里的电子书元信息
    const future = (collectionDeleted.entities['book-1'].deletedAt ?? 0) + 31 * 86400_000
    const pruned = prune(collectionDeleted, future)
    expect(pruned.entities['book-1'].purged).toBe(true)
  })

  test('三方合并能同步电子书进度并无冲突合并互补标签', () => {
    let base = createDocument('Rain')
    const space = children(base, null).find(e => e.kind === 'space')!
    const collection = children(base, space.id).find(e => e.kind === 'collection')!
    base = apply(base, {
      type: 'add-book',
      parentId: collection.id,
      id: 'book-1',
      title: '三体',
      storage: 'quark',
      fileName: 'three-body.epub',
      quarkFid: 'fid-1',
    })
    base = apply(base, { type: 'add-tag', id: 'tag-a', name: '收藏', color: 'green' })

    const local = apply(base, { type: 'set-tags', id: 'book-1', tagIds: ['tag-a'] })
    const remote = apply(base, { type: 'edit', id: 'book-1', patch: { progress: 65, chapterIndex: 2, scrollRatio: 0.3 } })

    const merged = merge(base, local, remote)
    expect(merged.conflicts).toHaveLength(0)
    const mergedBook = merged.doc.entities['book-1']
    if (mergedBook.kind !== 'book') throw new Error('expected book')
    expect(mergedBook.progress).toBe(65)
    expect(mergedBook.tagIds).toEqual(['tag-a'])
  })
})

describe('EPUB 解析与阅读进度计算', () => {
  test('正确解析 EPUB 2 NCX 目录、书名与相对资源路径', () => {
    const parsed = parseEpub(buildSampleEpub(), 'fallback.epub')
    expect(parsed.title).toBe('沙丘编年史')
    expect(parsed.author).toBe('弗兰克·赫伯特')
    expect(parsed.chapters).toHaveLength(2)
    expect(parsed.chapters[0].href).toBe('OEBPS/Text/chapter1.xhtml')
    expect(parsed.toc.map(item => item.title)).toEqual(['第一章 启程', '第二章 沙海'])
    expect(parsed.toc[1].chapterIndex).toBe(1)
    expect(parsed.toc[1].fragment).toBe('sec2')
    expect(parsed.resolveHref('OEBPS/Text/chapter1.xhtml', '../Images/cover.png').path).toBe('OEBPS/Images/cover.png')
    expect(parsed.readEntry('OEBPS/Images/cover.png')).toEqual(new Uint8Array([137, 80, 78, 71]))
  })

  test('正确解析 EPUB 3 Nav 嵌套目录与无标题回退', () => {
    const parsed = parseEpub(buildSampleEpub({ title: '   ', useNav: true }), 'my-book.epub')
    expect(parsed.title).toBe('my-book')
    expect(parsed.toc[1].chapterIndex).toBe(1)
    expect(parsed.toc[1].children).toHaveLength(1)
    expect(parsed.toc[1].children[0].title).toBe('2.1 沙虫')
    expect(parsed.toc[1].children[0].chapterIndex).toBe(1)
  })

  test('按章节权重与滚动比例稳定计算 0..100 阅读百分比', () => {
    const chapters = [{ weight: 100 }, { weight: 300 }]
    expect(computeReadingProgress(chapters, 0, 0)).toBe(0)
    expect(computeReadingProgress(chapters, 0, 1)).toBe(25)
    expect(computeReadingProgress(chapters, 1, 0.5)).toBe(63)
    expect(computeReadingProgress(chapters, 1, 0.995)).toBe(100)
  })
})

describe('QuarkClient 大文件分片上传与字节下载', () => {
  test('超过 partSize 时按分片顺序上传并提交全部 Part ETag', async () => {
    const partSize = 4
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) // 3 parts: 4 + 4 + 2
    const uploadedParts: { partNumber: number; bytes: Uint8Array }[] = []
    let commitXml = ''
    let finished = false
    const headerListeners: ((details: chrome.webRequest.OnHeadersReceivedDetails) => void)[] = []

    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: { id: 'test-ext', getURL: (path: string) => `chrome-extension://test-ext/${path}` },
        declarativeNetRequest: {
          HeaderOperation: { SET: 'set', REMOVE: 'remove' },
          RuleActionType: { MODIFY_HEADERS: 'modifyHeaders' },
          ResourceType: { XMLHTTPREQUEST: 'xmlhttprequest' },
          updateSessionRules: async () => undefined,
        },
        webRequest: {
          onHeadersReceived: {
            addListener: (fn: (details: chrome.webRequest.OnHeadersReceivedDetails) => void) => headerListeners.push(fn),
            removeListener: (fn: (details: chrome.webRequest.OnHeadersReceivedDetails) => void) => {
              const idx = headerListeners.indexOf(fn)
              if (idx >= 0) headerListeners.splice(idx, 1)
            },
          },
        },
      },
    })

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString())
      for (const listener of [...headerListeners]) {
        listener({
          initiator: 'chrome-extension://test-ext',
          url: url.href,
          statusCode: 200,
          responseHeaders: [],
        } as unknown as chrome.webRequest.OnHeadersReceivedDetails)
      }
      if (url.pathname.endsWith('/file/upload/pre')) {
        return new Response(JSON.stringify({
          status: 200,
          data: {
            task_id: 't1',
            upload_id: 'u1',
            auth_info: 'a1',
            upload_url: 'oss-cn-hangzhou.aliyuncs.com',
            obj_key: 'books/test.epub',
            bucket: 'b1',
            fid: 'fid-epub-1',
            callback: { callbackUrl: 'https://cb.quark.cn', callbackBody: 'ok' },
          },
          metadata: { part_size: partSize },
        }), { status: 200 })
      }
      if (url.pathname.endsWith('/file/update/hash')) {
        return new Response(JSON.stringify({ status: 200, data: { finish: false } }), { status: 200 })
      }
      if (url.pathname.endsWith('/file/upload/auth')) {
        return new Response(JSON.stringify({ status: 200, data: { auth_key: 'auth-sig' } }), { status: 200 })
      }
      if (url.hostname === 'b1.oss-cn-hangzhou.aliyuncs.com' && init?.method === 'PUT') {
        const partNumber = Number(url.searchParams.get('partNumber'))
        const buf = new Uint8Array(init.body as ArrayBuffer)
        uploadedParts.push({ partNumber, bytes: buf })
        return new Response('', { status: 200, headers: { etag: `"etag-${partNumber}"` } })
      }
      if (url.hostname === 'b1.oss-cn-hangzhou.aliyuncs.com' && init?.method === 'POST') {
        commitXml = String(init.body)
        const expectedMd5 = createHash('md5').update(commitXml).digest('base64')
        expect(new Headers(init?.headers).get('Content-MD5')).toBe(expectedMd5)
        return new Response('', { status: 200 })
      }
      if (url.pathname.endsWith('/file/upload/finish')) {
        finished = true
        return new Response(JSON.stringify({ status: 200 }), { status: 200 })
      }
      if (url.pathname.endsWith('/file/download')) {
        return new Response(JSON.stringify({ status: 200, data: [{ download_url: 'https://cdn.quark.cn/book.epub' }] }), { status: 200 })
      }
      if (url.hostname === 'cdn.quark.cn') {
        return new Response(payload, { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url.toString()}`)
    }) as typeof fetch

    const client = new QuarkClient('__puus=test')
    const uploaded = await client.uploadFile({
      fileName: 'big.epub',
      parentFid: 'dir-books',
      bytes: payload,
      mimeType: 'application/epub+zip',
    })

    expect(uploaded).toEqual({ created: true, fid: 'fid-epub-1' })
    expect(uploadedParts.map(p => p.partNumber)).toEqual([1, 2, 3])
    expect(uploadedParts.map(p => p.bytes.byteLength)).toEqual([4, 4, 2])
    expect(commitXml).toContain('<PartNumber>1</PartNumber><ETag>"etag-1"</ETag>')
    expect(commitXml).toContain('<PartNumber>3</PartNumber><ETag>"etag-3"</ETag>')
    expect(finished).toBe(true)

    const downloaded = await client.downloadFileBytes('fid-epub-1')
    expect(downloaded).toEqual(payload)
  })

  test('超过 200MB 上限时直接拒绝上传', async () => {
    const client = new QuarkClient('__puus=test')
    const oversized = { byteLength: MAX_QUARK_EPUB_BYTES + 1 } as Uint8Array
    await expect(client.uploadFile({
      fileName: 'huge.epub',
      parentFid: 'dir-books',
      bytes: oversized,
      mimeType: 'application/epub+zip',
    })).rejects.toThrow(/200\s*MB/)
  })
})
