import { z } from 'zod'
import { readLocalSnapshot } from './local-workspace'

const uploadResponse = z.object({
  code: z.literal(200),
  data: z.object({
    url: z.url().refine(value => /^https?:\/\//i.test(value)),
    upload_status: z.literal(1).optional(),
  }),
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
  const result = uploadResponse.safeParse(body)
  if (!response.ok || !result.success) {
    const message = z.object({ message: z.string() }).safeParse(body)
    const detail = message.success ? message.data.message.replaceAll(key, '[已隐藏]').slice(0, 300) : ''
    throw new Error(`s.ee 图片上传失败${detail ? `：${detail}` : response.ok ? '：返回的图片地址无效' : `（HTTP ${response.status}）`}`)
  }
  return result.data.data.url
}
