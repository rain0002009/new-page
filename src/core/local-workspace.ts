import { createDocument, type Conflict, type Document } from './model'
import { emptyDocument } from './merge'
import type { Snapshot } from './protocol'
import type { Connection } from './remote'
import type { ImageCleanup, ImageOwner, LocalImageDocument } from './hosted-images'

export type BookCleanup = { sourceId: string; fid: string; accountId: string; folderId: string }
export type WorkspaceSource = { config: Connection | null; doc: Document; base: Document; etag: string | null; resolvedRevision?: string | null; pendingNoteIds?: string[]; conflicts: Conflict[]; status: Snapshot['status']; error: string; lastSync: number | null }
export type StoredWorkspace = { active: string | null; sources: Record<string, WorkspaceSource>; editors?: Record<string, { tabId: number; token: string }>; imageCleanup?: ImageCleanup[]; imageDocuments?: Record<string, LocalImageDocument>; imageOwners?: Record<string, ImageOwner>; bookCleanup?: BookCleanup[] }
export const storageKey = 'new-page.workspace.v1'

export function ensureLocalWorkspace(root: StoredWorkspace): StoredWorkspace {
  if (!root.active || !root.sources[root.active]) {
    root.active = 'local'
    root.sources['local'] = {
      config: null,
      doc: createDocument('朋友'),
      base: emptyDocument(),
      etag: null,
      conflicts: [],
      status: 'local',
      error: '',
      lastSync: null,
    }
  }
  return root
}

export function workspaceSnapshot(root: StoredWorkspace): Snapshot {
  const source = root.active ? root.sources[root.active] : null
  const config = source?.config
  const connection: Snapshot['connection'] = config ? 'url' in config ? { kind: 'webdav', url: config.url, username: config.username } : { kind: 'quark', url: 'https://pan.quark.cn/', username: config.nickname } : null
  return source ? { sourceId: root.active, document: source.doc, connection, status: !config ? 'local' : source.conflicts.length ? 'conflict' : source.status, conflicts: source.conflicts, error: source.error, lastSync: source.lastSync } : { sourceId: null, document: null, connection: null, status: 'pending', error: '', conflicts: [], lastSync: null }
}

export async function readLocalSnapshot(): Promise<Snapshot> {
  const stored = await chrome.storage.local.get(storageKey)
  const root = ensureLocalWorkspace((stored[storageKey] as StoredWorkspace | undefined) ?? { active: null, sources: {} })
  return workspaceSnapshot(root)
}
