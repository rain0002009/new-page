import { describe, it, expect } from 'vitest'
import { ensureLocalWorkspace, workspaceSnapshot, type StoredWorkspace } from '../../src/core/local-workspace'
import { syncStatusLabels } from '../../src/core/protocol'

describe('Local Library workspace and snapshot', () => {
  it('identifies unlinked local storage with status "local"', () => {
    const root: StoredWorkspace = {
      active: 'local',
      sources: {
        local: {
          config: null,
          doc: { format: 'new-page', version: 1, entities: {} },
          base: { format: 'new-page', version: 1, entities: {} },
          etag: null,
          conflicts: [],
          status: 'local',
          error: '',
          lastSync: null,
        },
      },
    }
    const snapshot = workspaceSnapshot(root)
    expect(snapshot.sourceId).toBe('local')
    expect(snapshot.connection).toBeNull()
    expect(snapshot.status).toBe('local')
    expect(syncStatusLabels[snapshot.status]).toBe('未连接云端')
  })

  it('initializes default space and collection when empty', () => {
    const empty: StoredWorkspace = { active: null, sources: {} }
    const root = ensureLocalWorkspace(empty)
    expect(root.active).toBe('local')
    const source = root.sources.local
    expect(source).toBeDefined()
    expect(source.config).toBeNull()
    expect(source.status).toBe('local')
    const entities = Object.values(source.doc.entities)
    expect(entities.some(e => e.kind === 'space' && e.title === '我的空间')).toBe(true)
    expect(entities.some(e => e.kind === 'collection' && e.title === '日常收藏')).toBe(true)
  })
})
