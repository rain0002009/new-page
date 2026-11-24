import type { StoredWorkspace as Root } from './local-workspace'
import { imageCredential, imageIsReferenced, sourceImageKey } from './hosted-images'
import { deleteHostedImage, findHostedImages } from './see'

let imageCleanupChain: Promise<unknown> = Promise.resolve()

export function executeImageCleanup(
  id: string,
  atomic: <T>(work: (root: Root) => T | Promise<T>) => Promise<T>,
  broadcast: () => void
): Promise<unknown> {
  const work = imageCleanupChain.catch(() => {}).then(async () => {
    const batch = await atomic(root => {
      const source = root.sources[id]
      if (!source || source.status !== 'synced' || source.conflicts.length) return null
      const jobs = (root.imageCleanup ?? []).filter(
        job => job.sourceId === id && job.notBefore <= Date.now() && !imageIsReferenced(root, job.url)
      )
      return jobs.length ? { key: sourceImageKey(root, id), jobs: structuredClone(jobs) } : null
    })
    if (!batch) return

    try {
      if (!batch.key) throw new Error('图片待删除：请在设置中恢复 s.ee API Key，系统将自动重试')
      const credential = imageCredential(batch.key)
      const eligible = batch.jobs.filter(job => !job.credential || job.credential === credential)
      const cached = await atomic(root =>
        new Map(
          eligible.flatMap(job => {
            const owner = root.imageOwners?.[job.url]
            return owner?.sourceId === id && owner.credential === credential && owner.hash
              ? ([[job.url, { hash: owner.hash, revision: owner.revision }]] as const)
              : []
          })
        )
      )
      const unresolved = eligible.filter(job => !cached.has(job.url))
      const hashes = unresolved.length
        ? await findHostedImages(batch.key, unresolved.map(job => job.url))
        : new Map<string, string>()
      for (const [url, owner] of cached) hashes.set(url, owner.hash)

      let unknownOwner = false
      for (const job of eligible) {
        const ready = await atomic(root => {
          const source = root.sources[id]
          const pending = root.imageCleanup?.find(
            candidate => candidate.sourceId === id && candidate.url === job.url
          )
          return (
            !!pending &&
            pending.revision === job.revision &&
            pending.notBefore <= Date.now() &&
            source?.status === 'synced' &&
            !source.conflicts.length &&
            sourceImageKey(root, id) === batch.key &&
            !imageIsReferenced(root, job.url)
          )
        })
        if (!ready) continue

        const hash = hashes.get(job.url)
        if (!hash && !job.credential) {
          unknownOwner = true
          continue
        }

        // Only an exact match in the authenticated account authorizes deletion.
        // External URLs and already-absent files need no deletion request.
        if (hash) {
          try {
            await deleteHostedImage(batch.key, hash)
          } catch (cause) {
            // A timed-out request may already have deleted the file. Resolve
            // its URL through authenticated history again on the next retry.
            await atomic(root => {
              const owner = root.imageOwners?.[job.url]
              if (owner?.hash === hash && owner.revision === cached.get(job.url)?.revision) delete owner.hash
            })
            throw cause
          }
        }

        await atomic(root => {
          root.imageCleanup = root.imageCleanup?.filter(
            candidate => candidate.sourceId !== id || candidate.url !== job.url || candidate.revision !== job.revision
          )
          if (
            hash &&
            root.imageOwners &&
            cached.has(job.url) &&
            root.imageOwners[job.url]?.revision === cached.get(job.url)?.revision
          ) {
            delete root.imageOwners[job.url]
          }
        })
      }

      if (unknownOwner) throw new Error('无法确认待删除图片的原账号，请恢复原 s.ee API Key 后重试')
      if (eligible.length !== batch.jobs.length) {
        throw new Error('图片待删除：s.ee API Key 已变更，请恢复移除图片时使用的 Key 后重试')
      }
    } catch (cause) {
      await atomic(root => {
        const source = root.sources[id]
        if (source) {
          source.status = 'error'
          source.error = cause instanceof Error ? `图床图片清理未完成：${cause.message}` : '图床图片清理失败，稍后自动重试'
        }
      })
    }
    broadcast()
  })

  imageCleanupChain = work
  return work
}
