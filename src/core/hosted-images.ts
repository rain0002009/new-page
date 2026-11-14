import { sha256 } from '@noble/hashes/sha2.js'
import { imageReferences, removedImageReferences } from './image-references'
import type { Document } from './model'
import type { StoredWorkspace } from './local-workspace'

export type ImageCleanup = { sourceId: string; url: string; credential: string; notBefore: number; revision: string }
export type LocalImageDocument = { urls: string[] }
export type ImageOwner = { sourceId: string; credential: string; hash?: string; revision: string }

export function imageCredential(key: string): string {
  return Array.from(sha256(new TextEncoder().encode(key.trim())), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function sourceImageKey(root: StoredWorkspace, sourceId: string): string {
  const profile = root.sources[sourceId]?.doc.entities.profile
  return profile?.kind === 'profile' ? profile.seeApiKey?.trim() ?? '' : ''
}

export function queueRemovedImages(root: StoredWorkspace, sourceId: string, before: string, after: string) {
  const urls = removedImageReferences(before, after)
  if (!urls.length) return
  const key = sourceImageKey(root, sourceId)
  root.imageCleanup ??= []
  for (const url of urls) {
    const owner = root.imageOwners?.[url]
    const ownerId = owner?.sourceId ?? sourceId
    const credential = owner?.credential ?? (key ? imageCredential(key) : '')
    const existing = root.imageCleanup.find(job => job.sourceId === ownerId && job.url === url)
    if (existing) { existing.notBefore = Date.now() + 30_000; existing.revision = crypto.randomUUID() }
    else root.imageCleanup.push({ sourceId: ownerId, url, credential, notBefore: Date.now() + 30_000, revision: crypto.randomUUID() })
  }
}

// Recycle-bin notes retain their references until they are permanently purged.
export function queueDocumentImageChanges(root: StoredWorkspace, sourceId: string, before: Document, after: Document) {
  for (const note of Object.values(before.entities)) {
    if (note.kind !== 'note' || note.purged) continue
    const next = after.entities[note.id]
    if (next?.kind === 'note' && !next.purged && next.body === note.body) continue
    queueRemovedImages(root, sourceId, note.body, next?.kind === 'note' && !next.purged ? next.body : '')
  }
}

export function imageIsReferenced(root: StoredWorkspace, url: string): boolean {
  for (const source of Object.values(root.sources)) {
    const notes = [...Object.values(source.doc.entities), ...source.conflicts.flatMap(conflict => [conflict.local, conflict.remote])]
    if (notes.some(note => note?.kind === 'note' && !note.purged && imageReferences(note.body).has(url))) return true
  }
  return Object.values(root.imageDocuments ?? {}).some(document => document.urls.includes(url))
}

export function updateLocalImageDocument(root: StoredWorkspace, id: string, body: string, previous?: string, sourceId = root.active) {
  root.imageDocuments ??= {}
  root.imageDocuments[id] = { urls: [...imageReferences(body)] }
  if (previous !== undefined && sourceId && root.sources[sourceId]) queueRemovedImages(root, sourceId, previous, body)
}
