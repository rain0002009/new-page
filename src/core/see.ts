import { z } from 'zod'
import { readLocalSnapshot } from './local-workspace'

const responseStatus = z.object({
  code: z.number().int().optional(),
  success: z.boolean().optional(),
  message: z.string().optional(),
  data: z.unknown().optional(),
})
const uploadedImage = z.object({
  url: z.url().refine(value => /^https?:\/\//i.test(value)),
})

export async function readSeeApiKey(): Promise<string> {
  const snapshot = await readLocalSnapshot()
  const profile = snapshot.document?.entities.profile
  return profile?.kind === 'profile' ? profile.seeApiKey?.trim() ?? '' : ''
}

export async function uploadImage(file: File, signal: AbortSignal): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件')
  const key = await readSeeApiKey()
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
  return result.data.url
}
