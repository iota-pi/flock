import {
  listPersistedAutomergeDocs,
  readPersistedAutomergeDoc,
  removePersistedAutomergeDoc,
  type PersistedDocRecord,
  writePersistedAutomergeDoc,
} from './automergeDocStorage'
import {
  initializeAutomergeWorkerDocs,
  mergeAutomergeWorkerRecord,
  type PersistedWorkerRecord,
  type WorkerEntrySnapshot,
  type WorkerSerializedEntry,
} from '../workers/automergeDocWorkerManager'

type ApplyWorkerEntry = (
  entry: WorkerEntrySnapshot,
  options?: { hasLocalChanges?: boolean },
) => void

type HasLocalChanges = (documentId: string) => boolean

type PersistEntry = (
  account: string,
  itemId: string,
  serialized: WorkerSerializedEntry,
  hasLocalChanges: boolean,
) => Promise<void>

type RemoveDocumentState = (documentId: string) => Promise<void>

function decodeBase64ToBytes(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }

  return bytes
}

function asUint8Array(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? decodeBase64ToBytes(value) : value
}

function toPersistedWorkerRecord(value: PersistedDocRecord): PersistedWorkerRecord {
  return {
    itemId: value.itemId,
    doc: asUint8Array(value.doc),
    syncState: asUint8Array(value.syncState),
    cursor: value.cursor,
  }
}

export async function persistAutomergeEntry(
  account: string,
  itemId: string,
  serialized: WorkerSerializedEntry,
  hasLocalChanges: boolean,
): Promise<void> {
  const persisted: PersistedDocRecord = {
    account,
    itemId,
    doc: serialized.doc,
    syncState: serialized.syncState,
    cursor: serialized.cursor,
    hasLocalChanges,
    updatedAt: Date.now(),
  }

  await writePersistedAutomergeDoc(account, itemId, persisted)
}

export async function initializeAutomergeOrchestratorState(input: {
  account: string
  applyWorkerEntry: ApplyWorkerEntry
}): Promise<void> {
  const persistedRecords = await listPersistedAutomergeDocs(input.account)
  const localChangesByDocumentId = new Map(
    persistedRecords.map(record => [record.itemId, record.hasLocalChanges === true]),
  )

  const initializedEntries = await initializeAutomergeWorkerDocs(
    input.account,
    persistedRecords.map(toPersistedWorkerRecord),
  )

  for (const entry of initializedEntries) {
    input.applyWorkerEntry(entry, {
      hasLocalChanges: localChangesByDocumentId.get(entry.documentId) === true,
    })
  }
}

export async function refreshDocumentFromStorage(input: {
  documentId: string
  loadedAccount: string | null
  hasLocalChanges: HasLocalChanges
  applyWorkerEntry: ApplyWorkerEntry
  persistEntry: PersistEntry
  removeDocumentState: RemoveDocumentState
}): Promise<void> {
  if (input.hasLocalChanges(input.documentId)) {
    return
  }

  if (!input.loadedAccount) {
    return
  }

  const stored = await readPersistedAutomergeDoc(input.loadedAccount, input.documentId)

  if (!stored || typeof stored !== 'object') {
    await input.removeDocumentState(input.documentId)
    return
  }

  const merged = await mergeAutomergeWorkerRecord(toPersistedWorkerRecord(stored))
  if (!merged) {
    await input.removeDocumentState(input.documentId)
    return
  }

  if (input.hasLocalChanges(input.documentId)) {
    return
  }

  const nextHasLocalChanges = stored.hasLocalChanges === true
    || input.hasLocalChanges(input.documentId)

  input.applyWorkerEntry(merged, {
    hasLocalChanges: nextHasLocalChanges,
  })

  await input.persistEntry(input.loadedAccount, input.documentId, merged.serialized, nextHasLocalChanges)
}

export async function removePersistedAutomergeEntry(account: string, itemId: string): Promise<void> {
  await removePersistedAutomergeDoc(account, itemId)
}
