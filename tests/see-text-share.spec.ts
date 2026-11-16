import { test, expect } from '@playwright/test'
import {
  createTextShare,
  deleteTextShare,
  fetchSeeDomains,
  updateTextShare,
  validateTextShareLength,
} from '../src/core/see'

const originalFetch = globalThis.fetch

test.afterEach(() => {
  globalThis.fetch = originalFetch
})

test('validateTextShareLength 检查 <= 2097152 字节，超限抛出错误', () => {
  expect(() => validateTextShareLength('普通笔记正文')).not.toThrow()
  const largeAscii = 'a'.repeat(2_097_152)
  expect(() => validateTextShareLength(largeAscii)).not.toThrow()
  const tooLargeAscii = 'a'.repeat(2_097_153)
  expect(() => validateTextShareLength(tooLargeAscii)).toThrow(/2MB/)

  // 多字节字符（如中文每个占 3 字节）
  const chinese = '中'.repeat(700_000) // 2,100,000 bytes
  expect(() => validateTextShareLength(chinese)).toThrow(/2MB/)
})

test('fetchSeeDomains 调用域名接口并进行缓存', async () => {
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    expect(String(input)).toBe('https://s.ee/api/v1/domains')
    expect(init?.headers).toEqual({ Authorization: 'Bearer test-key' })
    return Response.json({
      code: 0,
      data: { domains: ['s.ee', 'fs.to', 'custom.domain'] },
      message: 'success',
    })
  }

  const domains = await fetchSeeDomains('test-key', true)
  expect(domains).toEqual(['s.ee', 'fs.to', 'custom.domain'])
  expect(calls).toBe(1)

  // 再次调用使用缓存，不发起二次 fetch
  const cached = await fetchSeeDomains('test-key')
  expect(cached).toEqual(['s.ee', 'fs.to', 'custom.domain'])
  expect(calls).toBe(1)
})

test('createTextShare 发送 POST 请求并固定 markdown 格式，不传递 tag_ids', async () => {
  let sentBody: any = null
  globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe('https://s.ee/api/v1/text')
    expect(init?.method).toBe('POST')
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
    sentBody = JSON.parse(init?.body as string)
    return Response.json({
      code: 0,
      data: {
        slug: 'abc1234',
        short_url: 'https://fs.to/abc1234',
      },
    })
  }

  const result = await createTextShare('test-key', {
    title: '我的笔记分享',
    content: '# 笔记标题\n\n正文内容',
    domain: 'fs.to',
    expire_at: 1775000000,
    custom_slug: 'my-custom',
    password: 'secretpassword',
  })

  expect(sentBody).toEqual({
    title: '我的笔记分享',
    content: '# 笔记标题\n\n正文内容',
    domain: 'fs.to',
    text_type: 'markdown',
    expire_at: 1775000000,
    custom_slug: 'my-custom',
    password: 'secretpassword',
  })
  expect(sentBody.tag_ids).toBeUndefined()
  expect(result).toEqual({
    slug: 'abc1234',
    shortUrl: 'https://fs.to/abc1234',
  })
})

test('updateTextShare 发送 PUT 请求更新正文与标题', async () => {
  let sentBody: any = null
  globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe('https://s.ee/api/v1/text')
    expect(init?.method).toBe('PUT')
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
    sentBody = JSON.parse(init?.body as string)
    return Response.json({ code: 0, message: 'success' })
  }

  await updateTextShare('test-key', {
    domain: 'fs.to',
    slug: 'abc1234',
    title: '更新后的标题',
    content: '# 最新正文',
  })

  expect(sentBody).toEqual({
    domain: 'fs.to',
    slug: 'abc1234',
    title: '更新后的标题',
    content: '# 最新正文',
  })
})

test('deleteTextShare 发送 DELETE 请求下线短链', async () => {
  let sentBody: any = null
  globalThis.fetch = async (input, init) => {
    expect(String(input)).toBe('https://s.ee/api/v1/text')
    expect(init?.method).toBe('DELETE')
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'Content-Type': 'application/json',
    })
    sentBody = JSON.parse(init?.body as string)
    return Response.json({ code: 0, message: 'success' })
  }

  await deleteTextShare('test-key', {
    domain: 'fs.to',
    slug: 'abc1234',
  })

  expect(sentBody).toEqual({
    domain: 'fs.to',
    slug: 'abc1234',
  })
})
