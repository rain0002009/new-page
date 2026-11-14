import { test, expect } from '@playwright/test'
import { createDocument } from '../src/core/model'
import { storageKey, type StoredWorkspace } from '../src/core/local-workspace'
import { deleteHostedImage, findHostedImages, uploadImage } from '../src/core/see'
import { imageCredential } from '../src/core/hosted-images'
import type { Request, Result } from '../src/core/protocol'

const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
const originalFetch = globalThis.fetch
const imageUrl = 'https://images.example.test/upload.png'
let storedWorkspace: StoredWorkspace
let snapshotReads = 0
let rpcRequests: Request[] = []
let rpcResult: Result = { ok: true }

test.beforeEach(() => {
  const doc = createDocument('测试')
  if (doc.entities.profile.kind === 'profile') doc.entities.profile.seeApiKey = 'see-test-key'
  storedWorkspace = { active: 'test', sources: { test: { config: { kind: 'quark', accountId: 'test', folderId: 'test', nickname: '测试' }, doc, base: doc, etag: null, conflicts: [], status: 'synced', error: '', lastSync: null } } }
  snapshotReads = 0; rpcRequests = []; rpcResult = { ok: true }
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
    runtime: { sendMessage: async (request: Request) => { rpcRequests.push(request); return rpcResult } },
    storage: { local: { get: async () => { snapshotReads++; return { [storageKey]: storedWorkspace } } } },
  } })
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

test('s.ee 上传成功保留 hash 并登记到发起上传的数据源，切库后不改绑或发送密钥明文', async () => {
  globalThis.fetch = async (_input, init) => {
    expect(init?.headers).toEqual({ Authorization: 'Bearer see-test-key' })
    const switched = createDocument('切换后的账号')
    if (switched.entities.profile.kind === 'profile') switched.entities.profile.seeApiKey = 'different-private-key'
    storedWorkspace.sources.other = { ...storedWorkspace.sources.test, doc: switched, base: switched }
    storedWorkspace.active = 'other'
    return Response.json({ code: 200, success: true, data: { url: imageUrl, hash: 'delete-upload-hash' } })
  }
  await expect(uploadImage(new File(['image'], 'test.png', { type: 'image/png' }), new AbortController().signal)).resolves.toBe(imageUrl)
  expect(snapshotReads).toBe(1)
  expect(rpcRequests).toEqual([{ type: 'uploaded-image', sourceId: 'test', url: imageUrl, hash: 'delete-upload-hash', credential: imageCredential('see-test-key') }])
  expect(JSON.stringify(rpcRequests)).not.toContain('see-test-key')
  expect(JSON.stringify(rpcRequests)).not.toContain('different-private-key')
})

test('s.ee 缺少可选 hash 的上传仍保存图片归属和凭据指纹', async () => {
  await expect(respond({ code: 200, data: { url: imageUrl } })).resolves.toBe(imageUrl)
  expect(rpcRequests).toEqual([{ type: 'uploaded-image', sourceId: 'test', url: imageUrl, hash: undefined, credential: imageCredential('see-test-key') }])
})

test('s.ee 无当前数据源时不上传也不登记其他账号图片', async () => {
  storedWorkspace.active = null
  let uploads = 0
  globalThis.fetch = async () => { uploads++; return Response.json({ code: 200, data: { url: imageUrl } }) }
  await expect(uploadImage(new File(['image'], 'test.png', { type: 'image/png' }), new AbortController().signal)).rejects.toThrow('请先在设置页保存 s.ee API Key')
  expect(snapshotReads).toBe(1)
  expect(uploads).toBe(0)
  expect(rpcRequests).toEqual([])
})

test('s.ee 上传后后台登记失败时明确报告图片已经上传但记录未保存', async () => {
  rpcResult = { ok: false, error: '写入失败' }
  await expect(respond({ code: 200, data: { url: imageUrl, hash: 'delete-upload-hash' } })).rejects.toThrow('图片已上传，但删除记录保存失败')
  expect(rpcRequests).toHaveLength(1)
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

test('s.ee 按分页上传历史匹配图片直链，移除片段且只返回指定图片的删除凭据', async () => {
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    expect(init?.headers).toEqual({ Authorization: 'Bearer account-key' })
    expect(init?.credentials).toBe('omit')
    expect(init?.redirect).toBe('error')
    const page = new URL(String(input)).searchParams.get('page')
    const data = page === '1' ? [{ url: 'https://other.example/a.png', hash: 'unrelated' }]
      : page === '2' ? [{ url: imageUrl, hash: 'delete-key' }, { url: 'https://images.example.test/without-key.png' }]
      : []
    return Response.json({ code: 200, success: true, data })
  }
  expect(await findHostedImages('account-key', [`${imageUrl}#preview`])).toEqual(new Map([[imageUrl, 'delete-key']]))
  expect(requests).toEqual([1, 2, 3].map(page => `https://s.ee/api/v1/files?page=${page}`))
})

test('s.ee 匹配的图片记录缺少 hash 时保留失败状态，不误报图片不存在', async () => {
  globalThis.fetch = async () => Response.json({ code: 200, success: true, data: [{ url: imageUrl }] })
  await expect(findHostedImages('account-key', [imageUrl])).rejects.toThrow('图片记录缺少删除凭据')
})

test('s.ee 当前账号查不到旧图片时不猜测删除凭据', async () => {
  let calls = 0
  globalThis.fetch = async () => Response.json({ code: 0, data: calls++ ? [] : [{ url: 'https://different-account.test/a.png', hash: 'unrelated' }] })
  expect(await findHostedImages('different-account-key', [imageUrl])).toEqual(new Map())
  globalThis.fetch = async () => { throw new Error('不应请求非法地址') }
  expect(await findHostedImages('account-key', ['data:image/png;base64,test', 'file:///image.png'])).toEqual(new Map())
})

test('s.ee 查询失败或分页无法结束时拒绝使用部分匹配结果', async () => {
  globalThis.fetch = async () => Response.json({ code: 200, data: [{ url: imageUrl, hash: 'delete-key' }] })
  await expect(findHostedImages('account-key', [imageUrl])).rejects.toThrow('分页重复')
  for (const body of [{ code: 401, data: [] }, { success: false, data: [] }, { data: {} }, { code: '200', data: [] }]) {
    globalThis.fetch = async () => Response.json(body)
    await expect(findHostedImages('account-key', [imageUrl])).rejects.toThrow('查询图片记录失败')
  }
  let page = 0
  globalThis.fetch = async () => Response.json({ data: [{ url: `https://other.example/${page++}.png`, hash: 'different-key' }] })
  await expect(findHostedImages('account-key', [imageUrl])).rejects.toThrow('超出分页范围')
})

test('s.ee 同一图片存在多个删除凭据时停止清理', async () => {
  let page = 0
  globalThis.fetch = async () => Response.json({ data: [{ url: imageUrl, hash: `delete-${page++}` }] })
  await expect(findHostedImages('account-key', [imageUrl])).rejects.toThrow('多个删除凭据')
})

test('s.ee 删除使用固定接口、编码凭据且接受官方字符串成功码', async () => {
  for (const code of ['200', 'success', undefined]) {
    globalThis.fetch = async (input, init) => {
      expect(String(input)).toBe('https://s.ee/api/v1/file/delete/hash%2F%3F%23%20value')
      expect(init).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer account-key' }, credentials: 'omit', redirect: 'error', cache: 'no-store' })
      expect(init?.signal).toBeTruthy()
      return Response.json({ success: true, code })
    }
    await expect(deleteHostedImage('account-key', 'hash/?# value')).resolves.toBeUndefined()
  }
})

test('s.ee 不把 HTTP 错误、明确失败或未知删除响应视为成功，错误不泄漏凭据', async () => {
  const key = 'private-account-key', hash = 'private-delete-hash'
  for (const [body, status] of [
    [{ success: true, code: '200' }, 404],
    [{ success: false, code: '200', message: `${key} ${hash}` }, 200],
    [{ success: true, code: '401', message: `${key} ${hash}` }, 200],
    [{ code: '200' }, 200],
    [{ success: true, code: 500 }, 200],
  ] as const) {
    globalThis.fetch = async () => Response.json(body, { status })
    const error = await deleteHostedImage(key, hash).catch(cause => cause as Error)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).not.toContain(key)
    expect((error as Error).message).not.toContain(hash)
  }
  globalThis.fetch = async () => { throw new Error(`${key} ${hash}`) }
  await expect(deleteHostedImage(key, hash)).rejects.toThrow('请检查网络')
  await expect(findHostedImages(key, [imageUrl])).rejects.toThrow('请检查网络')
  globalThis.fetch = async () => new Response(`${key} ${hash}`, { status: 200 })
  await expect(deleteHostedImage(key, hash)).rejects.toThrow('格式无效')
})

test('s.ee 清理请求需要密钥和删除凭据，并传递取消信号', async () => {
  globalThis.fetch = async () => { throw new Error('不应请求') }
  await expect(deleteHostedImage('', 'hash')).rejects.toThrow('配置 s.ee API Key')
  await expect(deleteHostedImage('account-key', '')).rejects.toThrow('缺少删除凭据')
  await expect(findHostedImages('', [imageUrl])).rejects.toThrow('配置 s.ee API Key')
  const controller = new AbortController()
  controller.abort()
  globalThis.fetch = async (_input, init) => {
    expect(init?.signal?.aborted).toBe(true)
    throw new Error('已取消')
  }
  await expect(deleteHostedImage('account-key', 'hash', controller.signal)).rejects.toThrow('已取消')
})
