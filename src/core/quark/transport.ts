// Quark's web API needs browser-forbidden request headers. Scope each temporary
// rule to this extension and exactly one URL; never change normal browsing.
import type { LoginProgress } from './progress'
export const quarkOrigins = ['https://*.quark.cn/*', 'https://*.uc.cn/*', 'https://*.aliyuncs.com/*']
const ruleId = 73101
let queue: Promise<unknown> = Promise.resolve()
const cookieUpdates = new WeakMap<Response, string[]>()

export function mergeCookieString(current: string, updates: string[]) {
  const jar = new Map(current.split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=')
    return [part.slice(0, index), part.slice(index + 1)]
  }))
  for (const update of updates) {
    const part = update.split(';')[0], index = part.indexOf('=')
    if (index < 1) continue
    const key = part.slice(0, index).trim(), value = part.slice(index + 1)
    if (/max-age\s*=\s*0(?:;|$)/i.test(update) || !value) jar.delete(key)
    else jar.set(key, value)
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join('; ')
}
export function getResponseCookies(response: Response) { return cookieUpdates.get(response) ?? [] }

function allowedUrl(url: URL) {
  return url.protocol === 'https:' && !url.username && !url.password && quarkOrigins.some(pattern => {
    const match = /^https:\/\/(\*\.)?([^/]+)\//.exec(pattern)!
    return url.hostname === match[2] || (match[1] && url.hostname.endsWith(`.${match[2]}`))
  })
}
export function quarkFetch(input: string | URL, init: RequestInit = {}, progress?: LoginProgress): Promise<Response> {
  progress?.('queued')
  const task = queue.then(async () => {
    progress?.('headers')
    let url = new URL(input), method = init.method ?? 'GET', body = init.body
    const headers = new Headers(init.headers), headerRules: chrome.declarativeNetRequest.ModifyHeaderInfo[] = []
    let cookie = headers.get('cookie') ?? ''
    headers.delete('cookie')
    for (const header of ['origin', 'referer', 'user-agent']) {
      const value = headers.get(header)
      if (value !== null) {
        headerRules.push({ header, operation: chrome.declarativeNetRequest.HeaderOperation.SET, value })
        headers.delete(header)
      }
    }
    const updates: string[] = [], signal = AbortSignal.timeout(25_000)
    for (let hop = 0; hop < 5; hop++) {
      if (!allowedUrl(url)) throw new Error('夸克接口返回了不受信任的地址，已停止传送登录信息')
      let location = '', status = 0
      let headersSeen = false
      let receivedHeaders = () => {}
      const received: string[] = []
      const listener = (details: chrome.webRequest.OnHeadersReceivedDetails): undefined => {
        if (details.initiator !== chrome.runtime.getURL('').replace(/\/$/, '') || details.url !== url.href) return
        status = details.statusCode
        for (const header of details.responseHeaders ?? []) {
          if (header.name.toLowerCase() === 'set-cookie' && header.value) received.push(header.value)
          if (header.name.toLowerCase() === 'location' && header.value) location = header.value
        }
        headersSeen = true; receivedHeaders()
        return undefined
      }
      chrome.webRequest.onHeadersReceived.addListener(listener, { urls: [`${url.origin}/*`] }, ['responseHeaders', 'extraHeaders'])
      try {
        const cookieRule: chrome.declarativeNetRequest.ModifyHeaderInfo = cookie
          ? { header: 'cookie', operation: chrome.declarativeNetRequest.HeaderOperation.SET, value: cookie }
          : { header: 'cookie', operation: chrome.declarativeNetRequest.HeaderOperation.REMOVE }
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId], addRules: [{
          id: ruleId, priority: 1,
          action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders: [...headerRules, cookieRule] },
          condition: { initiatorDomains: [chrome.runtime.id], regexFilter: `^${url.href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, resourceTypes: [chrome.declarativeNetRequest.ResourceType.XMLHTTPREQUEST] },
        }] })
        let response: Response
        try {
          progress?.('fetching')
          response = await fetch(url, { ...init, method, body, headers, credentials: 'omit', cache: 'no-store', redirect: 'manual', signal })
        } catch { throw new Error('暂时无法连接夸克网盘，本地修改已保留，请检查网络后重试') }
        // Chrome may deliver the webRequest event after fetch resolves. Keep
        // the listener until it supplies rotated cookies and redirect headers.
        if (!headersSeen) await new Promise<void>((resolve, reject) => {
          const aborted = () => reject(new Error('读取夸克响应头超时，请稍后重试；本地修改已保留'))
          receivedHeaders = () => { signal.removeEventListener('abort', aborted); resolve() }
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        })
        updates.push(...received)
        if (location && [301, 302, 303, 307, 308].includes(status)) {
          if (init.redirect === 'error') throw new Error('夸克接口发生了意外跳转，请重新登录后重试')
          const next = new URL(location, url)
          if (next.origin !== url.origin) headers.delete('authorization')
          cookie = mergeCookieString(cookie, received)
          if (status === 303 || ([301, 302].includes(status) && method === 'POST')) { method = 'GET'; body = undefined; headers.delete('content-type') }
          url = next
          continue
        }
        if (response.type === 'opaqueredirect') throw new Error('无法读取夸克登录跳转，请刷新二维码后重试')
        cookieUpdates.set(response, updates)
        return response
      } finally {
        progress?.('cleanup')
        chrome.webRequest.onHeadersReceived.removeListener(listener)
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => undefined)
      }
    }
    throw new Error('夸克接口跳转次数过多，请稍后重试')
  })
  queue = task.catch(() => undefined)
  return task
}

