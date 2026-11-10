import { QuarkClient } from './client'
import { mergeCookieString } from './transport'
import type { QuarkEntry } from './types'
import type { LoginProgress } from './progress'

export type QuarkConnection = { kind: 'quark'; accountId: string; folderId: string; nickname: string }
export type QrState = { id: string; url: string; expiresAt: string; status: 'pending' | 'expired' | 'confirmed' }
type Login = QrState & { token: string; cookie: string }
type Auth = { login?: Login; accounts: Record<string, string> }
const key = 'new-page.quark.auth.v1'
let queue: Promise<unknown> = Promise.resolve()
let polling: Promise<{ qr: QrState; config?: QuarkConnection }> | null = null
function edit<T>(work: (state: Auth) => T | Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const stored = await chrome.storage.local.get(key)
    const state: Auth = (stored[key] as Auth | undefined) ?? { accounts: {} }
    const result = await work(state)
    await chrome.storage.local.set({ [key]: state })
    return result
  })
  queue = result.catch(() => undefined)
  return result
}
function publicQr(login: Login): QrState { return { id: login.id, url: login.url, expiresAt: login.expiresAt, status: login.status } }
export async function listAll(client: QuarkClient, parent: string): Promise<QuarkEntry[]> {
  const entries: QuarkEntry[] = []
  for (let page = 1; page <= 100; page++) {
    const items = await client.listDirectory(parent, { page, size: 200 })
    entries.push(...items)
    if (items.length < 200) return entries
  }
  throw new Error('夸克目录内容过多，读取已停止；本地数据未被删除')
}
export async function accountClient(config: QuarkConnection) {
  let cookie = await edit(state => state.accounts[config.accountId])
  if (!cookie) throw new Error('夸克登录已失效，请重新扫码；本地收藏仍可使用')
  return new QuarkClient(cookie, async updates => {
    const previous = cookie
    cookie = mergeCookieString(cookie, updates)
    await edit(state => { if (state.accounts[config.accountId] === previous) state.accounts[config.accountId] = cookie })
  })
}
export async function startQr(progress?: LoginProgress): Promise<QrState> {
  progress?.('preparing')
  let cookie = ''
  const client = new QuarkClient('', updates => { cookie = mergeCookieString(cookie, updates) })
  const result = await client.getTokenForQrcodeLogin(progress)
  const login: Login = { id: crypto.randomUUID(), token: result.qrToken, url: result.qrUrl, expiresAt: result.expiresAt, cookie, status: 'pending' }
  progress?.('storing')
  await edit(state => { state.login = login })
  return publicQr(login)
}
export function pollQr(id: string) {
  if (polling) return polling
  polling = finishQr(id).finally(() => { polling = null })
  return polling
}
async function finishQr(id: string): Promise<{ qr: QrState; config?: QuarkConnection }> {
  const login = await edit(state => state.login)
  if (!login || login.id !== id) throw new Error('二维码已更新，请重新扫码')
  if (Date.now() >= new Date(login.expiresAt).getTime()) return { qr: { ...publicQr(login), status: 'expired' } }
  const client = new QuarkClient(login.cookie, async updates => {
    login.cookie = mergeCookieString(login.cookie, updates)
    await edit(state => { if (state.login?.id === id) state.login.cookie = login.cookie })
  })
  const result = await client.getServiceTicketByQrcodeToken(login.token)
  if (result.status !== 'confirmed' || !result.serviceTicket) return { qr: { ...publicQr(login), status: result.status === 'expired' ? 'expired' : 'pending' } }
  await client.getAccountInfoByServiceTicket(result.serviceTicket)
  const info = await client.getAccountInfo()
  if (!login.cookie) throw new Error('未获取到夸克登录信息，请刷新二维码后重试')
  const folders = (await listAll(client, '0')).filter(entry => entry.isDirectory && entry.name === '拾页收藏').sort((a, b) => a.fid.localeCompare(b.fid))
  let folderId: string | undefined = folders[0]?.fid
  if (!folderId) {
    folderId = await client.createDirectory('0', '拾页收藏')
    // Some responses omit fid. Retry visibility instead of immediately failing.
    for (let attempt = 0; !folderId && attempt < 4; attempt++) {
      if (attempt) await new Promise(done => setTimeout(done, 400 * attempt))
      folderId = (await listAll(client, '0')).find(entry => entry.isDirectory && entry.name === '拾页收藏')?.fid
    }
  }
  if (!folderId) throw new Error('夸克目录尚未可见，请稍后重试；现有文件未被删除')
  const config: QuarkConnection = { kind: 'quark', accountId: folderId, folderId, nickname: info.nickname || '朋友' }
  await edit(state => {
    if (state.login?.id !== id) throw new Error('二维码已更新，请使用新的二维码')
    state.accounts[config.accountId] = login.cookie
    delete state.login
  })
  return { qr: { ...publicQr(login), status: 'confirmed' }, config }
}
