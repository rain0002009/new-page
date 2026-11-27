import { deleteBookBytes } from './epub-storage'
import type { StoredWorkspace as Root } from './local-workspace'
import { accountClient } from './quark/auth'
import { QuarkApiError } from './quark/types'
import { isQuark } from './remote'
import type { Document } from './model'

let bookCleanupChain: Promise<unknown> = Promise.resolve()

export function queueBookChanges(root: Root, sourceId: string, before: Document, after: Document) {
  const source = root.sources[sourceId]
  const config = source?.config
  for (const previous of Object.values(before.entities)) {
    if (previous.kind !== 'book' || previous.purged) continue
    const next = after.entities[previous.id]
    if (next?.kind === 'book' && !next.purged) continue
    void deleteBookBytes(previous.id).catch(() => undefined)
    if (previous.storage === 'quark' && previous.quarkFid && isQuark(config)) {
      root.bookCleanup ??= []
      if (!root.bookCleanup.some(job => job.sourceId === sourceId && job.fid === previous.quarkFid)) {
        root.bookCleanup.push({ sourceId, fid: previous.quarkFid, accountId: config.accountId, folderId: config.folderId })
      }
    }
  }
}

export function executeBookCleanup(
  id: string,
  atomic: <T>(work: (root: Root) => T | Promise<T>) => Promise<T>,
): Promise<unknown> {
  const work = bookCleanupChain.catch(() => {}).then(async () => {
    const batch = await atomic(root => {
      const source = root.sources[id]
      if (!source || !isQuark(source.config) || source.conflicts.length) return null
      const matching = (root.bookCleanup ?? []).filter(job => {
        if (job.sourceId !== id || !isQuark(source.config)) return false
        return job.accountId === source.config.accountId
      })
      return matching.length ? { config: source.config, jobs: structuredClone(matching) } : null
    })
    if (!batch) return
    try {
      const client = await accountClient(batch.config)
      for (const job of batch.jobs) {
        try {
          await client.deleteFile(job.fid)
        } catch (cause) {
          if (!(cause instanceof QuarkApiError && cause.status === 404)) throw cause
        }
        await atomic(root => {
          root.bookCleanup = root.bookCleanup?.filter(entry => entry.sourceId !== id || entry.fid !== job.fid)
        })
      }
    } catch { /* Retry on next sync if network or session temporarily fails. */ }
  })
  bookCleanupChain = work
  return work
}
