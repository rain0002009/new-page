import type { Action, Conflict, Document } from './model'
import type { Connection } from './remote'
import type { QrState, QuarkConnection } from './quark/auth'

export type Snapshot = {
  sourceId: string | null; document: Document | null
  connection: { kind?: 'quark' | 'webdav'; url: string; username: string } | null
  status: 'synced' | 'pending' | 'syncing' | 'error' | 'conflict'
  error: string; lastSync: number | null; conflicts: Conflict[]
}
export const syncStatusLabels: Record<Snapshot['status'], string> = { synced: '已同步', pending: '待同步', syncing: '正在同步', error: '同步未完成', conflict: '有冲突待处理' }
export type ConnectRequest = { type: 'connect'; config: Connection; nickname: string; mode: 'switch' | 'migrate'; confirmed?: boolean }
export type Request =
  | { type: 'snapshot' }
  | { type: 'read-markdown'; url: string }
  | { type: 'markdown-takeover'; enabled: boolean }
  | { type: 'open-original'; url: string }
  | { type: 'note-editor'; sourceId: string; id: string; token: string; takeover?: boolean }
  | { type: 'save-note'; sourceId: string; id: string; token: string; title: string; body: string }
  | { type: 'local-image-document'; id: string; body: string; previous?: string; sourceId?: string; aliases?: string[] }
  | { type: 'uploaded-image'; sourceId: string; url: string; credential: string; hash?: string }
  | { type: 'quark-qr-start'; traceId?: string }
  | { type: 'quark-qr-poll'; id: string }
  | { type: 'action'; sourceId: string; action: Action }
  | ConnectRequest
  | { type: 'sync'; sourceId: string }
  | { type: 'quark-repair'; sourceId: string }
  | { type: 'resolve'; sourceId: string; conflictId: string; side: 'local' | 'remote' }
  | { type: 'export'; sourceId: string }
  | { type: 'import'; sourceId: string; data: unknown; confirmed: boolean }
export type Result = { ok: true; file?: { body: string; url: string }; originalUrl?: string; editor?: boolean; snapshot?: Snapshot; confirmation?: string; backup?: Document; qr?: QrState; config?: QuarkConnection } | { ok: false; error: string }
export async function rpc(request: Request): Promise<Extract<Result, { ok: true }>> {
  const response = await chrome.runtime.sendMessage(request) as Result
  if (!response?.ok) throw new Error(response?.error || '扩展后台暂时不可用，请重试')
  return response
}
