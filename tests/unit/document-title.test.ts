import { describe, it, expect } from 'vitest'
import { DEFAULT_DOCUMENT_TITLE, resolveDocumentTitle, urlFilename } from '../../src/document/document-title'

describe('document title helpers', () => {
  it('returns the trimmed document name when non-empty', () => {
    expect(resolveDocumentTitle('周会纪要')).toBe('周会纪要')
    expect(resolveDocumentTitle('  guide.md  ')).toBe('guide.md')
  })

  it('falls back to the default title when blank or undefined', () => {
    expect(resolveDocumentTitle()).toBe(DEFAULT_DOCUMENT_TITLE)
    expect(resolveDocumentTitle('')).toBe(DEFAULT_DOCUMENT_TITLE)
    expect(resolveDocumentTitle('   \t\n  ')).toBe(DEFAULT_DOCUMENT_TITLE)
  })

  it('extracts decoded leaf filenames from document URLs', () => {
    expect(urlFilename('https://example.com/markdown/guide.MD?version=1#section')).toBe('guide.MD')
    expect(urlFilename('file:///C:/docs/%E5%BD%93%E5%89%8D%E6%96%87%E6%A1%A3.md')).toBe('当前文档.md')
    expect(urlFilename('https://example.com/markdown/')).toBe('')
    expect(urlFilename('not-a-url')).toBe('')
  })
})
