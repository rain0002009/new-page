import { test, expect } from '@playwright/test'
import { createDocument } from '../src/core/model'
import { storageKey } from '../src/core/local-workspace'
import { uploadImage } from '../src/core/see'

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
const originalFetch = globalThis.fetch
const imageUrl = 'https://images.example.test/upload.png'

test.beforeEach(() => {
  const doc = createDocument('测试')
  if (doc.entities.profile.kind === 'profile') doc.entities.profile.seeApiKey = 'see-test-key'
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: { get: async () => ({
    [storageKey]: { active: 'test', sources: { test: { config: { kind: 'quark', nickname: '测试' }, doc, base: doc, conflicts: [], status: 'synced', error: '', lastSync: null } } },
  }) } } } })
})

test.afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
  else Reflect.deleteProperty(globalThis, 'chrome')
})

function respond(body: unknown, status = 200) {
  globalThis.fetch = async () => Response.json(body, { status })
  return uploadImage(new File(['image'], 'test.png', { type: 'image/png' }), new AbortController().signal)
}

test('s.ee 接受文档中省略可选 code 的成功上传响应', async () => {
  await expect(respond({ message: 'success', data: { url: imageUrl, upload_status: 1 } })).resolves.toBe(imageUrl)
})

test('s.ee 接受官方 SDK 中 code 0 和文档中 code 200 的上传响应', async () => {
  for (const code of [0, 200]) {
    await expect(respond({ code, message: 'success', data: { url: imageUrl, upload_status: 1 } })).resolves.toBe(imageUrl)
  }
})

test('s.ee 接受真实接口 success true 且 upload_status 2 的成功响应', async () => {
  await expect(respond({ code: 200, message: 'success', success: true, data: {
    file_id: 33720633, width: 96, height: 96, filename: 'download.png', storename: 'download.png',
    size: 8440, path: '/2026/11/13/Kus3/download.png', url: imageUrl, page: 'https://fs.to/example',
    upload_status: 2, mime_type: 'image/png', created_at: 0, thumb_url: '',
  } })).resolves.toBe(imageUrl)
})

test('s.ee 成功消息不能掩盖响应中缺失的图片地址', async () => {
  await expect(respond({ code: 200, message: 'success', data: {} })).rejects.toThrow('s.ee 图片上传失败：返回的图片地址无效')
})

test('s.ee 拒绝 HTTP、业务码、明确失败标志和图片地址错误', async () => {
  await expect(respond({ code: 0, message: 'Unauthorized see-test-key', data: { url: imageUrl } }, 401)).rejects.toThrow('Unauthorized [已隐藏]')
  await expect(respond({ code: 403, message: '上传额度不足', data: null })).rejects.toThrow('上传额度不足')
  await expect(respond({ code: 200, success: false, message: '上传未完成', data: { url: imageUrl, upload_status: 2 } })).rejects.toThrow('上传未完成')
  await expect(respond({ code: 0, success: false, message: '上传失败', data: { url: imageUrl, upload_status: 0 } })).rejects.toThrow('s.ee 图片上传失败')
  for (const url of ['javascript:alert(1)', 'data:image/png;base64,test', 'file:///test.png', '']) {
    await expect(respond({ code: 0, data: { url } })).rejects.toThrow('s.ee 图片上传失败')
  }
})
