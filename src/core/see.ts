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

export const MAX_TEXT_SHARE_LENGTH = 2_097_152

export function validateTextShareLength(content: string): void {
  const bytes = new TextEncoder().encode(content).length
  if (content.length > MAX_TEXT_SHARE_LENGTH || bytes > MAX_TEXT_SHARE_LENGTH) {
    throw new Error('笔记内容超过分享限制（最大 2MB），无法分享')
  }
}

let domainCache: { key: string; domains: string[]; timestamp: number } | null = null

export async function fetchSeeDomains(key: string, force = false, signal?: AbortSignal): Promise<string[]> {
  if (!key.trim()) return ['s.ee']
  if (!force && domainCache && domainCache.key === key && Date.now() - domainCache.timestamp < 3600_000) {
    return domainCache.domains
  }
  let response: Response
  try {
    response = await fetch('https://s.ee/api/v1/domains', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
    })
  } catch {
    if (domainCache && domainCache.key === key) return domainCache.domains
    return ['s.ee']
  }
  if (!response.ok) {
    if (domainCache && domainCache.key === key) return domainCache.domains
    return ['s.ee']
  }
  const body: unknown = await response.json().catch(() => null)
  const schema = z.object({
    code: z.number().int().optional(),
    success: z.boolean().optional(),
    data: z.union([
      z.object({ domains: z.array(z.string()) }),
      z.array(z.string()),
    ]),
  })
  const parsed = schema.safeParse(body)
  let domains: string[] = []
  if (parsed.success) {
    const raw = Array.isArray(parsed.data.data) ? parsed.data.data : parsed.data.data.domains
    domains = raw.map(d => d.trim()).filter(Boolean)
  }
  if (!domains.includes('s.ee')) domains.unshift('s.ee')
  domainCache = { key, domains, timestamp: Date.now() }
  return domains
}

export type CreateTextShareParams = {
  title: string
  content: string
  domain: string
  expire_at?: number | null
  custom_slug?: string
  password?: string
}

export async function createTextShare(key: string, params: CreateTextShareParams, signal?: AbortSignal): Promise<{ slug: string; shortUrl: string }> {
  if (!key.trim()) throw new Error('请先在设置页保存 s.ee API Key，再分享笔记')
  validateTextShareLength(params.content)
  const payload: Record<string, unknown> = {
    title: params.title.trim() || '未命名笔记',
    content: params.content,
    domain: params.domain.trim() || 's.ee',
    text_type: 'markdown',
  }
  if (params.expire_at) payload.expire_at = params.expire_at
  if (params.custom_slug?.trim()) payload.custom_slug = params.custom_slug.trim()
  if (params.password?.trim()) payload.password = params.password.trim()

  let response: Response
  try {
    response = await fetch('https://s.ee/api/v1/text', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    })
  } catch {
    throw new Error(signal?.aborted ? '分享已取消' : '创建分享失败，请检查网络或稍后重试')
  }

  const body: unknown = await response.json().catch(() => null)
  const status = responseStatus.safeParse(body)
  const failedCode = status.success && status.data.code !== undefined && ![0, 200].includes(status.data.code)
  const failedResult = status.success && status.data.success === false
  if (!response.ok || failedCode || failedResult) {
    const message = z.object({ message: z.string() }).safeParse(body)
    const detail = message.success && !/^success$/i.test(message.data.message.trim()) ? message.data.message.replaceAll(key, '[已隐藏]').slice(0, 300) : ''
    const reason = !response.ok ? `HTTP ${response.status}` : failedCode && status.success ? `业务码 ${status.data.code}` : '服务返回创建失败'
    throw new Error(`s.ee 创建分享失败${detail ? `：${detail}` : `（${reason}）`}`)
  }

  const resultSchema = z.object({
    slug: z.string().optional(),
    custom_slug: z.string().optional(),
    short_url: z.string().optional(),
  })
  const parsedData = resultSchema.safeParse(status.success ? status.data.data : undefined)
  const slug = parsedData.success ? parsedData.data.slug || parsedData.data.custom_slug || params.custom_slug || '' : ''
  const shortUrl = parsedData.success && parsedData.data.short_url ? parsedData.data.short_url : (slug ? `https://${params.domain}/${slug}` : '')
  if (!slug || !shortUrl) throw new Error('s.ee 创建分享失败：返回的短链信息不完整')
  return { slug, shortUrl }
}

export type UpdateTextShareParams = {
  domain: string
  slug: string
  title: string
  content: string
}

export async function updateTextShare(key: string, params: UpdateTextShareParams, signal?: AbortSignal): Promise<void> {
  if (!key.trim()) throw new Error('请先在设置页保存 s.ee API Key，再更新分享')
  validateTextShareLength(params.content)
  const payload = {
    domain: params.domain.trim(),
    slug: params.slug.trim(),
    title: params.title.trim() || '未命名笔记',
    content: params.content,
  }

  let response: Response
  try {
    response = await fetch('https://s.ee/api/v1/text', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    })
  } catch {
    throw new Error(signal?.aborted ? '更新已取消' : '更新分享失败，请检查网络或稍后重试')
  }

  const body: unknown = await response.json().catch(() => null)
  const status = responseStatus.safeParse(body)
  const failedCode = status.success && status.data.code !== undefined && ![0, 200].includes(status.data.code)
  const failedResult = status.success && status.data.success === false
  if (!response.ok || failedCode || failedResult) {
    const message = z.object({ message: z.string() }).safeParse(body)
    const detail = message.success && !/^success$/i.test(message.data.message.trim()) ? message.data.message.replaceAll(key, '[已隐藏]').slice(0, 300) : ''
    const reason = !response.ok ? `HTTP ${response.status}` : failedCode && status.success ? `业务码 ${status.data.code}` : '服务返回更新失败'
    throw new Error(`s.ee 更新分享失败${detail ? `：${detail}` : `（${reason}）`}`)
  }
}

export type DeleteTextShareParams = {
  domain: string
  slug: string
}

export async function deleteTextShare(key: string, params: DeleteTextShareParams, signal?: AbortSignal): Promise<void> {
  if (!key.trim()) throw new Error('请先在设置页保存 s.ee API Key，再删除分享')
  let response: Response
  try {
    response = await fetch('https://s.ee/api/v1/text', {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ domain: params.domain.trim(), slug: params.slug.trim() }),
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    })
  } catch {
    throw new Error(signal?.aborted ? '删除已取消' : '删除分享失败，请检查网络或稍后重试')
  }

  const body: unknown = await response.json().catch(() => null)
  const status = responseStatus.safeParse(body)
  const failedCode = status.success && status.data.code !== undefined && ![0, 200].includes(status.data.code)
  const failedResult = status.success && status.data.success === false
  if (!response.ok || failedCode || failedResult) {
    const message = z.object({ message: z.string() }).safeParse(body)
    const detail = message.success && !/^success$/i.test(message.data.message.trim()) ? message.data.message.replaceAll(key, '[已隐藏]').slice(0, 300) : ''
    const reason = !response.ok ? `HTTP ${response.status}` : failedCode && status.success ? `业务码 ${status.data.code}` : '服务返回删除失败'
    throw new Error(`s.ee 删除分享失败${detail ? `：${detail}` : `（${reason}）`}`)
  }
}
