export type FileHandle = FileSystemFileHandle & {
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
}
export type DirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileHandle | DirectoryHandle]>
  queryPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
  requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>
}
export type LocalImageCleanup = { before: string; after: string; sourceId?: string }
export type LocalFile = { title: string; body: string; baseline: string; url?: string; dirty?: boolean; writable?: boolean; handle?: FileHandle; directory?: DirectoryHandle; path?: string[]; imageSourceId?: string; imageAliasIds?: string[]; pendingImageCleanup?: LocalImageCleanup[] }
export const markdownName = (name: string) => /\.(md|markdown)$/i.test(name)
export async function readFileHandle(handle: FileHandle, directory?: DirectoryHandle, path?: string[]): Promise<LocalFile> {
  const body = await (await handle.getFile()).text()
  return { title: handle.name, body, baseline: body, handle, directory, path }
}
export async function readDroppedMarkdown(transfer: DataTransfer): Promise<LocalFile> {
  const item = Array.from(transfer.items).find(item => item.kind === 'file' && markdownName(item.getAsFile()?.name ?? ''))
  if (!item) throw new Error('请拖入 .md 或 .markdown 文件')
  // Chrome only exposes the drop data during this event; capture both before awaiting.
  const file = item.getAsFile()!
  let fileHandle: FileHandle | undefined
  let writable = false
  try {
    const handle = await (item as DataTransferItem & { getAsFileSystemHandle?(): Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.()
    if (handle?.kind === 'file') {
      fileHandle = handle as FileHandle
      writable = !fileHandle.requestPermission || await fileHandle.requestPermission({ mode: 'readwrite' }) === 'granted'
      return { ...await readFileHandle(fileHandle), writable }
    }
  } catch { /* Chrome may deny filesystem access while still exposing the dropped File for reading. */ }
  const body = await file.text()
  return { title: file.name, body, baseline: body, handle: fileHandle, writable }
}
export async function relativeFile(file: LocalFile, value: string) {
  if (!file.directory || !file.path) throw new Error('相对资源需要文件夹访问权限')
  const segments = value.startsWith('/') ? [] : file.path.slice(0, -1)
  for (const segment of decodeURIComponent(value.split(/[?#]/)[0]).split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { if (!segments.length) throw new Error('资源超出已授权文件夹，请选择包含它的文件夹'); segments.pop() }
    else segments.push(segment)
  }
  let directory = file.directory
  for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment) as DirectoryHandle
  return { handle: await directory.getFileHandle(segments.at(-1)!) as FileHandle, path: segments }
}
async function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('page-garden-documents', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}
function cleanupIdentity(entry: LocalImageCleanup) { return JSON.stringify([entry.before, entry.after, entry.sourceId]) }
let remembering: Promise<unknown> = Promise.resolve()
export function rememberFile(file: LocalFile, id: string = crypto.randomUUID(), acknowledged: LocalImageCleanup[] = []): Promise<string> {
  const write = () => storeFile(file, id, acknowledged)
  const task = remembering.catch(() => {}).then(() => typeof navigator !== 'undefined' && navigator.locks
    ? navigator.locks.request('page-garden-local-files', write) : write())
  remembering = task
  return task
}
async function storeFile(file: LocalFile, id: string, acknowledged: LocalImageCleanup[]): Promise<string> {
  const db = await database()
  try {
    const records = await new Promise<{ id: string; file: LocalFile }[]>((resolve, reject) => {
      const tx = db.transaction('files'), store = tx.objectStore('files')
      const keys = store.getAllKeys(), values = store.getAll()
      tx.oncomplete = () => resolve(values.result.map((value, index) => ({ id: String(keys.result[index]), file: value as LocalFile })))
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    const same: typeof records = []
    for (const record of records) {
      if (record.id === id) { same.push(record); continue }
      if (file.handle && record.file.handle && await file.handle.isSameEntry(record.file.handle).catch(() => false)) same.push(record)
    }
    const canonical = same[0]?.id ?? id
    const existing = same.find(record => record.id === canonical)?.file
    if (!same.some(record => record.id === id) && existing?.dirty && !file.dirty) {
      // Opening the same handle under a new URL must not erase a recoverable draft.
      file.body = existing.body; file.baseline = existing.baseline; file.dirty = true
    }
    file.imageSourceId = existing?.imageSourceId ?? file.imageSourceId
    file.imageAliasIds = [...new Set(same.map(record => record.id).filter(value => value !== canonical))]
    const completed = new Set(acknowledged.map(cleanupIdentity))
    const queued = [...same.flatMap(record => record.file.pendingImageCleanup ?? []), ...(file.pendingImageCleanup ?? [])]
    file.pendingImageCleanup = [...new Map(queued.filter(entry => !completed.has(cleanupIdentity(entry))).map(entry => [cleanupIdentity(entry), entry])).values()]
    await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('files', 'readwrite'); tx.objectStore('files').put(file, canonical)
    // Preserve old IDs as aliases so existing document URLs still open the latest draft.
    for (const alias of file.imageAliasIds ?? []) tx.objectStore('files').put(file, alias)
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
    })
    return canonical
  } finally { db.close() }
}
export async function recallFile(id: string): Promise<LocalFile> {
  const db = await database()
  try { return await new Promise<LocalFile>((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(id)
    request.onsuccess = () => request.result ? resolve(request.result as LocalFile) : reject(new Error('本地文档授权记录已不存在，请重新选择文件'))
    request.onerror = () => reject(request.error)
  }) } finally { db.close() }
}
