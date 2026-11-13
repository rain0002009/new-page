import { WebDAV, sourceKey, normalizeConnection, type Connection as WebDAVConnection } from './webdav'
import { QuarkStore } from './quark/store'
import type { QuarkConnection } from './quark/auth'
import type { Conflict, Document } from './model'
export type RemoteRead = { doc: Document | null; etag: string | null; conflicts?: Conflict[] }
export type Connection = WebDAVConnection | QuarkConnection
export const isQuark = (config: Connection): config is QuarkConnection => 'kind' in config && config.kind === 'quark'
export function normalizeRemote(config: Connection): Connection {
  if (!isQuark(config)) return normalizeConnection(config)
  if (!config.accountId || config.accountId !== config.folderId || /[\r\n]/.test(config.accountId)) throw new Error('夸克账号信息无效，请重新扫码')
  return { kind: 'quark', accountId: config.accountId, folderId: config.folderId, nickname: config.nickname.slice(0, 80) }
}
export async function remoteKey(config: Connection) {
  return isQuark(config) ? `quark:${config.accountId}` : sourceKey(config)
}
export function remoteStore(config: Connection, knownRevision: string | null = null, noteIds: string[] = []) { return isQuark(config) ? new QuarkStore(config, knownRevision, noteIds) : new WebDAV(config) }
