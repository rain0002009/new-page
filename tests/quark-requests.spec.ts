import { test, expect } from '@playwright/test'
import { QuarkClient } from '../src/core/quark/client'
import { QuarkStore } from '../src/core/quark/store'
import { RevisionChanged } from '../src/core/webdav'
import { apply, createDocument } from '../src/core/model'
import type { QuarkEntry } from '../src/core/quark/types'

type StoredFile = QuarkEntry & { body: string }
const config = { kind: 'quark', accountId: 'test-account', folderId: 'root', nickname: 'Rain' } as const
const originalChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome')
const originals = {
  listDirectory: QuarkClient.prototype.listDirectory,
  downloadFileText: QuarkClient.prototype.downloadFileText,
  uploadSmallFile: QuarkClient.prototype.uploadSmallFile,
  createDirectory: QuarkClient.prototype.createDirectory,
  renameFile: QuarkClient.prototype.renameFile,
  deleteFile: QuarkClient.prototype.deleteFile,
}
const files = new Map<string, StoredFile>()
const downloads = new Map<string, number>()
const stored: Record<string, unknown> = {}

test.beforeEach(() => {
  files.clear(); downloads.clear()
  for (const key of Object.keys(stored)) delete stored[key]
  stored['new-page.quark.auth.v1'] = { accounts: { 'test-account': 'synthetic-cookie' } }
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { storage: { local: {
    get: async (key: string) => ({ [key]: stored[key] }),
    set: async (values: Record<string, unknown>) => { Object.assign(stored, values) },
  } } } })
  QuarkClient.prototype.listDirectory = async parent => [...files.values()].filter(file => file.parentFid === parent).map(({ body, ...entry }) => ({ ...entry }))
  QuarkClient.prototype.downloadFileText = async fid => {
    downloads.set(fid, (downloads.get(fid) ?? 0) + 1)
    const file = files.get(fid)
    if (!file) throw new Error('file missing')
    return file.body
  }
  QuarkClient.prototype.createDirectory = async (parentFid, name) => {
    const fid = crypto.randomUUID()
    files.set(fid, { fid, parentFid, name, isDirectory: true, size: 0, body: '' })
    return fid
  }
  QuarkClient.prototype.uploadSmallFile = async ({ parentFid, fileName, bytes }) => {
    const fid = crypto.randomUUID()
    files.set(fid, { fid, parentFid, name: fileName, size: bytes.byteLength, isDirectory: false, body: new TextDecoder().decode(bytes) })
    return { created: true, fid }
  }
  QuarkClient.prototype.renameFile = async (fid, name) => { files.get(fid)!.name = name }
  QuarkClient.prototype.deleteFile = async fid => { files.delete(fid) }
})

test.afterEach(() => {
  Object.assign(QuarkClient.prototype, originals)
  if (originalChrome) Object.defineProperty(globalThis, 'chrome', originalChrome)
  else Reflect.deleteProperty(globalThis, 'chrome')
})

async function history(count: number) {
  let doc = createDocument('Rain'), etag: string | null = null
  for (let index = 0; index < count; index++) {
    const store = new QuarkStore(config, etag)
    await store.read()
    doc = apply(doc, { type: 'edit', id: 'profile', patch: { title: `Rain ${index}` } })
    etag = await store.write(doc, etag)
  }
  downloads.clear()
  return { doc, etag: etag! }
}

test('夸克一次同步的前后版本检查不重复下载相同历史', async () => {
  const { etag } = await history(11)
  const store = new QuarkStore(config, etag)
  const remote = await store.read()
  await store.settle(remote.doc!, remote.etag!)
  const snapshots = [...files.values()].filter(file => file.name.startsWith('pg2-'))
  expect(snapshots).toHaveLength(11)
  expect(snapshots.map(file => downloads.get(file.fid))).toEqual(Array(11).fill(1))
})

test('夸克复用历史内容后仍检查新出现的并行版本', async () => {
  const { etag, doc } = await history(2)
  const first = new QuarkStore(config, etag)
  await first.read()
  const second = new QuarkStore(config, etag)
  await second.read()
  const changed = apply(doc, { type: 'edit', id: 'profile', patch: { title: '另一台设备' } })
  await second.write(changed, etag)
  await expect(first.settle(doc, etag)).rejects.toBeInstanceOf(RevisionChanged)
})

test('夸克同一文件的元数据变化后重新下载并校验历史', async () => {
  const { etag, doc } = await history(2)
  const store = new QuarkStore(config, etag)
  await store.read()
  const file = [...files.values()].find(file => file.name.startsWith('pg2-'))!
  file.body = '{broken'; file.size = file.body.length; file.updatedAt = 'changed'
  await expect(store.settle(doc, etag)).rejects.toThrow('夸克收藏文件已损坏')
  expect(downloads.get(file.fid)).toBe(2)
})
