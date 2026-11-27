const databaseName = 'page-garden-epubs'
const storeName = 'books'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName)
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => resolve(request.result)
  })
}

export async function putBookBytes(id: string, bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).put(new Uint8Array(bytes), id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

export async function getBookBytes(id: string): Promise<Uint8Array | undefined> {
  if (typeof indexedDB === 'undefined') return undefined
  const db = await openDatabase()
  try {
    return await new Promise<Uint8Array | undefined>((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(id)
      request.onsuccess = () => {
        const result = request.result
        if (!result) { resolve(undefined); return }
        if (result instanceof Uint8Array) { resolve(result); return }
        if (result instanceof ArrayBuffer) { resolve(new Uint8Array(result)); return }
        resolve(undefined)
      }
      request.onerror = () => reject(request.error)
    })
  } finally {
    db.close()
  }
}

export async function deleteBookBytes(id: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return
  const db = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite')
      tx.objectStore(storeName).delete(id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}
