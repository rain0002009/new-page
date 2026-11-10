import { quarkOrigins } from '../core/quark/transport'
import { rpc } from '../core/protocol'
import { quarkLoginStages, type QuarkLoginStage } from '../core/quark/progress'

export function allowQuarkAccess() {
  return withTimeout(checkQuarkAccess(), 15_000, '检查 Chrome 授权超时，请在扩展管理页重新加载扩展后重试')
}

async function checkQuarkAccess() {
  const permissions: chrome.permissions.Permissions = { origins: quarkOrigins, permissions: ['webRequest', 'declarativeNetRequestWithHostAccess'] }
  if (!await chrome.permissions.contains(permissions)) throw new Error('夸克访问权限未启用，请在扩展详情页允许访问夸克及上传服务后重试')
}

export async function loadQuarkQr() {
  const traceId = crypto.randomUUID()
  let progress = '后台尚未报告进度'
  const listener = (message: { type?: string; traceId?: string; stage?: string }, sender: chrome.runtime.MessageSender) => {
    if (sender.id === chrome.runtime.id && message.type === 'quark-login-stage' && message.traceId === traceId && message.stage && Object.hasOwn(quarkLoginStages, message.stage)) {
      progress = quarkLoginStages[message.stage as QuarkLoginStage]
    }
  }
  chrome.runtime.onMessage.addListener(listener)
  try {
    return await withTimeout(rpc({ type: 'quark-qr-start', traceId }), 30_000, () => `二维码请求超时（${progress}），请重试；仍然失败时，请在扩展管理页重新加载扩展`)
  } finally { chrome.runtime.onMessage.removeListener(listener) }
}

async function withTimeout<T>(request: Promise<T>, timeout: number, message: string | (() => string)): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(typeof message === 'function' ? message() : message)), timeout)
    })])
  } finally { clearTimeout(timer) }
}
