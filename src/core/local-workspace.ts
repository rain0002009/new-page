import type { Conflict, Document } from './model'
import type { Snapshot } from './protocol'
import type { Connection } from './remote'
import type { ImageCleanup, ImageOwner, LocalImageDocument } from './hosted-images'

export type WorkspaceSource = { config: Connection; doc: Document; base: Document; etag: string | null; resolvedRevision?: string | null; pendingNoteIds?: string[]; conflicts: Conflict[]; status: Snapshot['status']; error: string; lastSync: number | null }
export type StoredWorkspace = { active: string | null; sources: Record<string, WorkspaceSource>; editors?: Record<string, { tabId: number; token: string }>; imageCleanup?: ImageCleanup[]; imageDocuments?: Record<string, LocalImageDocument>; imageOwners?: Record<string, ImageOwner> }
export const storageKey = 'new-page.workspace.v1'

export function workspaceSnapshot(root: StoredWorkspace): Snapshot {
  const source = root.active ? root.sources[root.active] : null
  const config = source?.config
  const connection: Snapshot['connection'] = config ? 'url' in config ? { kind: 'webdav', url: config.url, username: config.username } : { kind: 'quark', url: 'https://pan.quark.cn/', username: config.nickname } : null
  return source ? { sourceId: root.active, document: source.doc, connection, status: source.conflicts.length ? 'conflict' : source.status, conflicts: source.conflicts, error: source.error, lastSync: source.lastSync } : { sourceId: null, document: null, connection: null, status: 'pending', error: '', conflicts: [], lastSync: null }
}

export async function readLocalSnapshot(): Promise<Snapshot> {
  const stored = await chrome.storage.local.get(storageKey)
  return workspaceSnapshot((stored[storageKey] as StoredWorkspace | undefined) ?? { active: null, sources: {} })
}
