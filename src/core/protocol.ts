import type { Action, Conflict, Document } from './model'
import type { Connection } from './webdav'

export type Snapshot = {
  sourceId: string | null; document: Document | null
  connection: { url: string; username: string } | null
  status: 'synced' | 'pending' | 'syncing' | 'error' | 'conflict'
  error: string; lastSync: number | null; conflicts: Conflict[]
}
export const syncStatusLabels: Record<Snapshot['status'], string> = { synced: '已同步', pending: '待同步', syncing: '正在同步', error: '同步未完成', conflict: '有冲突待处理' }
export type ConnectRequest = { type: 'connect'; config: Connection; nickname: string; mode: 'switch' | 'migrate'; confirmed?: boolean }
export type Request =
  | { type: 'snapshot' }
  | { type: 'action'; sourceId: string; action: Action }
  | ConnectRequest
  | { type: 'sync'; sourceId: string }
  | { type: 'resolve'; sourceId: string; conflictId: string; side: 'local' | 'remote' }
  | { type: 'export'; sourceId: string }
  | { type: 'import'; sourceId: string; data: unknown; confirmed: boolean }
export type Result = { ok: true; snapshot?: Snapshot; confirmation?: string; backup?: Document } | { ok: false; error: string }
export async function rpc(request: Request): Promise<Extract<Result, { ok: true }>> {
  const response = await chrome.runtime.sendMessage(request) as Result
  if (!response?.ok) throw new Error(response?.error || '扩展后台暂时不可用，请重试')
  return response
}
