import type { ItemId } from '../shared/itemTypes'

type CacheKey = ItemId | typeof METADATA_CACHE_KEY

type OpfsDirectoryHandle = {
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsFileHandle>
  removeEntry: (name: string) => Promise<void>
}

type OpfsFileHandle = {
  getFile: () => Promise<File>
  createWritable: () => Promise<{
    write: (data: BufferSource | Blob | string | Uint8Array) => Promise<void>
    close: () => Promise<void>
  }>
}

const itemAutomergeBinaryCache = new Map<CacheKey, Uint8Array>()

const METADATA_CACHE_KEY = '__account_metadata__'
const OPFS_DIR_NAME = 'flock-automerge-binaries'
const OPFS_INDEX_FILE_NAME = 'index.json'

let opfsDirPromise: Promise<OpfsDirectoryHandle | null> | null = null
let opfsHydratePromise: Promise<void> | null = null

function hasOpfs(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }

  const storage = navigator.storage as unknown as {
    getDirectory?: () => Promise<OpfsDirectoryHandle>
  }

  return typeof storage?.getDirectory === 'function'
}

async function getOpfsDirectory(): Promise<OpfsDirectoryHandle | null> {
  if (!hasOpfs()) {
    return null
  }

  if (opfsDirPromise) {
    return opfsDirPromise
  }

  opfsDirPromise = (async () => {
    try {
      const storage = navigator.storage as unknown as {
        getDirectory: () => Promise<{ getDirectoryHandle: (name: string, options?: { create?: boolean }) => Promise<OpfsDirectoryHandle> }>
      }

      const rootHandle = await storage.getDirectory()
      return rootHandle.getDirectoryHandle(OPFS_DIR_NAME, { create: true })
    } catch {
      return null
    }
  })()

  return opfsDirPromise
}

function toEntryFileName(cacheKey: CacheKey): string {
  return `entry-${encodeURIComponent(cacheKey)}.bin`
}

async function readTextFile(handle: OpfsFileHandle): Promise<string> {
  const file = await handle.getFile()
  return file.text()
}

async function readBinaryFile(handle: OpfsFileHandle): Promise<Uint8Array> {
  const file = await handle.getFile()
  return new Uint8Array(await file.arrayBuffer())
}

async function writeFile(handle: OpfsFileHandle, contents: BufferSource | Blob | string | Uint8Array): Promise<void> {
  const writable = await handle.createWritable()
  await writable.write(contents)
  await writable.close()
}

async function readIndex(directory: OpfsDirectoryHandle): Promise<CacheKey[]> {
  try {
    const indexHandle = await directory.getFileHandle(OPFS_INDEX_FILE_NAME)
    const rawText = await readTextFile(indexHandle)
    const parsed = JSON.parse(rawText)

    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed.filter(value => typeof value === 'string') as CacheKey[]
  } catch {
    return []
  }
}

async function writeIndex(directory: OpfsDirectoryHandle, keys: CacheKey[]): Promise<void> {
  const indexHandle = await directory.getFileHandle(OPFS_INDEX_FILE_NAME, { create: true })
  await writeFile(indexHandle, JSON.stringify(keys))
}

export async function hydrateAutomergeBinaryCache(): Promise<void> {
  if (opfsHydratePromise) {
    return opfsHydratePromise
  }

  opfsHydratePromise = (async () => {
    const directory = await getOpfsDirectory()
    if (!directory) {
      return
    }

    const keys = await readIndex(directory)
    await Promise.all(keys.map(async cacheKey => {
      try {
        const fileHandle = await directory.getFileHandle(toEntryFileName(cacheKey))
        const binary = await readBinaryFile(fileHandle)
        itemAutomergeBinaryCache.set(cacheKey, binary)
      } catch {
        // Ignore missing or unreadable entries and keep cache warm for remaining keys.
      }
    }))
  })().finally(() => {
    opfsHydratePromise = null
  })

  return opfsHydratePromise
}

async function persistEntry(cacheKey: CacheKey, binary: Uint8Array): Promise<void> {
  const directory = await getOpfsDirectory()
  if (!directory) {
    return
  }

  const fileHandle = await directory.getFileHandle(toEntryFileName(cacheKey), { create: true })
  await writeFile(fileHandle, binary)

  const keys = new Set(await readIndex(directory))
  keys.add(cacheKey)
  await writeIndex(directory, Array.from(keys))
}

async function removeEntry(cacheKey: CacheKey): Promise<void> {
  const directory = await getOpfsDirectory()
  if (!directory) {
    return
  }

  try {
    await directory.removeEntry(toEntryFileName(cacheKey))
  } catch {
    // Entry may already be absent.
  }

  const keys = new Set(await readIndex(directory))
  keys.delete(cacheKey)
  await writeIndex(directory, Array.from(keys))
}

void hydrateAutomergeBinaryCache()

export function getCachedAutomergeBinary(itemId: ItemId): Uint8Array | undefined {
  return itemAutomergeBinaryCache.get(itemId)
}

export function setCachedAutomergeBinary(itemId: ItemId, binary: Uint8Array): void {
  itemAutomergeBinaryCache.set(itemId, binary)
  void persistEntry(itemId, binary)
}

export function clearCachedAutomergeBinary(itemId: ItemId): void {
  itemAutomergeBinaryCache.delete(itemId)
  void removeEntry(itemId)
}

export function getCachedMetadataAutomergeBinary(): Uint8Array | undefined {
  return itemAutomergeBinaryCache.get(METADATA_CACHE_KEY)
}

export function setCachedMetadataAutomergeBinary(binary: Uint8Array): void {
  itemAutomergeBinaryCache.set(METADATA_CACHE_KEY, binary)
  void persistEntry(METADATA_CACHE_KEY, binary)
}
