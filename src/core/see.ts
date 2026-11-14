import { z } from 'zod'
import { readLocalSnapshot } from './local-workspace'
import { imageCredential } from './hosted-images'
import { rpc } from './protocol'

const responseStatus = z.object({
  code: z.number().int().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
})
const uploadedImage = z.object({
  url: z.url().refine(value => /^https?:\/\//i.test(value)),
  hash: z.string().optional(),
})

export async function readSeeApiKey(): Promise<string> {
  const snapshot = await readLocalSnapshot()
  const profile = snapshot.document?.entities.profile
  return profile?.kind === 'profile' ? profile.seeApiKey?.trim() ?? '' : ''
}

export async function uploadImage(file: File, signal: AbortSignal): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  const snapshot = await readLocalSnapshot()
  const profile = snapshot.document?.entities.profile
  const key = profile?.kind === 'profile' ? profile.seeApiKey?.trim() ?? '' : ''
  if (!key) throw new Error('请先在设置页保存 s.ee API Key，再上传图片')
  const form = new FormData()
  form.append('file', file)
  let response: Response
  try {
    response = await fetch('https://s.ee/api/v1/file/upload', {
      method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form,
      credentials: 'omit', redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    })
  } catch {
    throw new Error(signal.aborted ? '图片上传已取消' : '图片上传失败，请检查网络或稍后重试')
  }
  const body: unknown = await response.json().catch(() => undefined)
  const status = responseStatus.safeParse(body)
  const result = uploadedImage.safeParse(status.success ? status.data.data : undefined)
  // The reference describes code 200; official SDK upload fixtures use code 0.
  const failedCode = status.success && status.data.code !== undefined && ![0, 200].includes(status.data.code)
  const failedResult = status.success && status.data.success === false
  // upload_status is metadata in the official SDKs; live success can have value 2.
  if (!response.ok || failedCode || failedResult) {
    const message = z.object({ message: z.string() }).safeParse(body)
    const detail = message.success && !/^success$/i.test(message.data.message.trim()) ? message.data.message.replaceAll(key, '[已隐藏]').slice(0, 300) : ''
    const reason = !response.ok ? `HTTP ${response.status}` : failedCode && status.success ? `业务码 ${status.data.code}` : '服务返回上传失败'
    throw new Error(`s.ee 图片上传失败${detail ? `：${detail}` : `（${reason}）`}`)
  }
  if (!result.success) throw new Error('s.ee 图片上传失败：返回的图片地址无效')
  if (snapshot.sourceId) {
    try {
      await rpc({ type: 'uploaded-image', sourceId: snapshot.sourceId, url: result.data.url, hash: result.data.hash, credential: imageCredential(key) })
    } catch {
      throw new Error('图片已上传，但删除记录保存失败；请重试或到 s.ee 管理图片')
    }
  }
  return result.data.url
}

function imageAddress(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (!['https:', 'http:'].includes(url.protocol)) return undefined
    url.hash = ''
    return url.href
  } catch { return undefined }
}

async function imageRequest(key: string, path: string, action: string, signal?: AbortSignal): Promise<unknown> {
  if (!key.trim()) throw new Error('请先配置 s.ee API Key，再清理图床图片')
  let response: Response
  try {
    response = await fetch(`https://s.ee/api/v1/${path}`, {
      method: 'GET', headers: { Authorization: `Bearer ${key}` },
      credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    })
  } catch {
    // Service and transport errors can contain the API key or delete hash.
    throw new Error(signal?.aborted ? `s.ee ${action}已取消` : `s.ee ${action}失败，请检查网络或稍后重试`)
  }
  if (!response.ok) throw new Error(`s.ee ${action}失败（HTTP ${response.status}）`)
  try { return await response.json() } catch { throw new Error(`s.ee ${action}失败：服务返回格式无效`) }
}

export async function findHostedImages(key: string, urls: string[], signal?: AbortSignal): Promise<Map<string, string>> {
  const wanted = new Set(urls.map(imageAddress).filter((url): url is string => url !== undefined))
  const found = new Map<string, string>()
  if (!wanted.size) return found
  const history = responseStatus.extend({ data: z.array(z.object({ url: z.string(), hash: z.string().optional() })) })
  const pages = new Set<string>()
  for (let page = 1; page <= 100; page++) {
    const parsed = history.safeParse(await imageRequest(key, `files?page=${page}`, '查询图片记录', signal))
    if (!parsed.success || parsed.data.success === false || (parsed.data.code !== undefined && ![0, 200].includes(parsed.data.code))) {
      throw new Error('s.ee 查询图片记录失败：服务返回失败或格式无效')
    }
    const records = parsed.data.data
    if (!records.length) return found
    const fingerprint = JSON.stringify(records.map(({ url, hash }) => [url, hash]).sort())
    if (pages.has(fingerprint)) throw new Error('s.ee 查询图片记录失败：分页重复，无法确认全部记录')
    pages.add(fingerprint)
    for (const record of records) {
      const url = imageAddress(record.url)
      if (!url || !wanted.has(url)) continue
      if (!record.hash?.trim()) throw new Error('s.ee 查询图片记录失败：图片记录缺少删除凭据')
      const previous = found.get(url)
      if (previous && previous !== record.hash) throw new Error('s.ee 查询图片记录失败：同一图片对应多个删除凭据')
      found.set(url, record.hash)
    }
  }
  throw new Error('s.ee 查询图片记录失败：超出分页范围，无法确认全部记录')
}

export async function deleteHostedImage(key: string, hash: string, signal?: AbortSignal): Promise<void> {
  if (!hash.trim()) throw new Error('s.ee 删除图片失败：缺少删除凭据')
  const result = z.object({ success: z.literal(true), code: z.enum(['200', 'success']).optional() }).safeParse(
    await imageRequest(key, `file/delete/${encodeURIComponent(hash)}`, '删除图片', signal),
  )
  if (!result.success) throw new Error('s.ee 删除图片失败：服务未确认删除成功')
}
