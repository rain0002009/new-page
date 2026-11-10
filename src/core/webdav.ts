import { readDocument, type Document } from './model'

export type Connection = { url: string; username: string; password: string }
export function normalizeConnection(input: Connection): Connection {
  let url: URL
  try { url = new URL(input.url) } catch { throw new Error('请输入有效的 HTTPS WebDAV 地址') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请使用不包含凭据或查询参数的 HTTPS WebDAV 地址')
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  if (!input.username.trim() || !input.password) throw new Error('请填写用户名和密码或应用专用密码')
  return { url: url.href, username: input.username.trim(), password: input.password }
}
export async function sourceKey(config: Connection) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${config.url}\n${config.username}`))
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
export class RevisionChanged extends Error {}
export class WebDAV {
  private folder: string
  private authorization: string
  constructor(private config: Connection) {
    this.folder = new URL('new-page/', config.url).href
    this.authorization = `Basic ${btoa(Array.from(new TextEncoder().encode(`${config.username}:${config.password}`), b => String.fromCharCode(b)).join(''))}`
  }
  private async request(url: string, method: string, headers: Record<string, string> = {}, body?: string) {
    let response: Response
    try {
      response = await fetch(url, { method, headers: { Authorization: this.authorization, ...headers }, body, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12_000) })
    } catch { throw new Error('无法连接 WebDAV，已保留本地修改。请检查网络、证书和服务器访问权限') }
    if (response.status === 401 || response.status === 403) throw new Error('WebDAV 认证或权限失败，请检查用户名、密码及目录权限')
    return response
  }
  private strongTag(response: Response) {
    const tag = response.headers.get('ETag')
    if (!tag || !/^"[^"\r\n]*"$/.test(tag)) throw new Error('此 WebDAV 未提供可靠的文件版本，无法安全同步；本地数据已保留')
    return tag
  }
  async verify() {
    const properties = await this.request(this.config.url, 'PROPFIND', { Depth: '0' })
    if (![200, 207].includes(properties.status)) throw new Error(`WebDAV 目录不可读取（${properties.status}）`)
    const directory = await this.request(this.folder, 'MKCOL')
    if (![201, 405].includes(directory.status)) throw new Error(`无法创建应用数据目录（${directory.status}）`)
    const probe = `${this.folder}.connection-${crypto.randomUUID()}.json`
    let created = false
    try {
      const first = await this.request(probe, 'PUT', { 'If-None-Match': '*', 'Content-Type': 'application/json' }, '{"probe":true}')
      if (!first.ok) throw new Error(`WebDAV 不允许写入（${first.status}）`)
      created = true
      const read = await this.request(probe, 'GET')
      if (!read.ok) throw new Error('WebDAV 不允许读取已写入的文件')
      this.strongTag(read)
      const refused = await this.request(probe, 'PUT', { 'If-Match': `"invalid-${crypto.randomUUID()}"`, 'Content-Type': 'application/json' }, '{"probe":false}')
      const duplicate = await this.request(probe, 'PUT', { 'If-None-Match': '*', 'Content-Type': 'application/json' }, '{"probe":false}')
      if (refused.status !== 412 || duplicate.status !== 412) throw new Error('此 WebDAV 不支持安全的条件写入，无法启用自动同步')
    } finally {
      if (created) await this.request(probe, 'DELETE').catch(() => undefined)
    }
  }
  async read(): Promise<{ doc: Document | null; etag: string | null }> {
    const response = await this.request(`${this.folder}data-v1.json`, 'GET')
    if (response.status === 404) return { doc: null, etag: null }
    if (!response.ok) throw new Error(`读取 WebDAV 失败（${response.status}），原数据未被覆盖`)
    const text = await response.text()
    if (text.length > 15_000_000) throw new Error('远端文件过大，请先导出备份并整理数据')
    let data: unknown
    try { data = JSON.parse(text) } catch { throw new Error('远端文件不是有效的收藏数据，原文件未被覆盖') }
    return { doc: readDocument(data), etag: this.strongTag(response) }
  }
  async write(doc: Document, etag: string | null): Promise<string> {
    const response = await this.request(`${this.folder}data-v1.json`, 'PUT', {
      ...(etag ? { 'If-Match': etag } : { 'If-None-Match': '*' }), 'Content-Type': 'application/json; charset=utf-8',
    }, JSON.stringify(doc))
    if (response.status === 412) throw new RevisionChanged('远端已改变，正在重新合并')
    if (!response.ok) throw new Error(`上传失败（${response.status}），本地修改已保留`)
    // Do not GET a potentially newer revision here and attribute its ETag to this write.
    return this.strongTag(response)
  }
}
