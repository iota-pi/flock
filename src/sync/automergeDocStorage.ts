import localforage from 'localforage'

const STORE_NAME = 'automerge-documents'
const DOC_RECORD_PREFIX = 'doc:'

export type PersistedDocRecord = {
  account: string
  itemId: string
  doc: Uint8Array | string
  syncState: Uint8Array | string
  cursor: number
  hasLocalChanges?: boolean
  updatedAt: number
}

const store = localforage.createInstance({
  name: 'FlockVaultDB',
  storeName: STORE_NAME,
})

function toDocStorageKey(account: string, itemId: string): string {
  return `${DOC_RECORD_PREFIX}${account}:${itemId}`
}

export async function listPersistedAutomergeDocs(account: string): Promise<PersistedDocRecord[]> {
  const results: PersistedDocRecord[] = []

  await store.iterate<PersistedDocRecord, void>((value, key) => {
    if (!key.startsWith(`${DOC_RECORD_PREFIX}${account}:`)) {
      return
    }

    if (!value || typeof value !== 'object' || typeof value.itemId !== 'string') {
      return
    }

    results.push(value)
  })

  return results
}

export async function readPersistedAutomergeDoc(account: string, itemId: string): Promise<PersistedDocRecord | null> {
  const value = await store.getItem<PersistedDocRecord>(toDocStorageKey(account, itemId))
  return value || null
}

export async function writePersistedAutomergeDoc(
  account: string,
  itemId: string,
  value: PersistedDocRecord,
): Promise<void> {
  await store.setItem(toDocStorageKey(account, itemId), value)
}

export async function removePersistedAutomergeDoc(account: string, itemId: string): Promise<void> {
  await store.removeItem(toDocStorageKey(account, itemId))
}

export async function clearPersistedAutomergeDocs(): Promise<void> {
  await store.clear()
}