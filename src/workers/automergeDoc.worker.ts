import * as Automerge from '@automerge/automerge'
import { expose, transfer } from 'comlink'

const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

type SyncState = ReturnType<typeof Automerge.initSyncState>

type PersistedWorkerRecord = {
  itemId: string
  doc: Uint8Array
  syncState: Uint8Array
  cursor?: number
}

type WorkerSerializedEntry = {
  doc: Uint8Array
  syncState: Uint8Array
  cursor: number
}

type WorkerEntrySnapshot = {
  documentId: string
  serialized: WorkerSerializedEntry
  snapshot: Record<string, unknown>
}

type WorkerReceiveSyncMessageResult = WorkerEntrySnapshot & {
  changed: boolean
}

type WorkerCreateSyncMessageResult = {
  message: Uint8Array | null
  nextSyncState: Uint8Array
}

type WorkerSetSnapshotInput = {
  documentId: string
  snapshot: Record<string, unknown>
  cursor?: number
  syncState?: Uint8Array
}

type WorkerSetBinaryInput = {
  documentId: string
  binary: Uint8Array
  cursor?: number
  syncState?: Uint8Array
}

type WorkerReceiveMessageInput = {
  documentId: string
  message: Uint8Array
  cursor?: number
  syncState?: Uint8Array
}

type WorkerCommitSyncStateInput = {
  documentId: string
  syncState: Uint8Array
}

type WorkerSetCursorInput = {
  documentId: string
  cursor: number
}

type WorkerEntry = {
  doc: Automerge.Doc<Record<string, unknown>>
  syncState: SyncState
  cursor: number
}

const entriesByDocumentId = new Map<string, WorkerEntry>()

function addTransferable(transferables: Transferable[], bytes: Uint8Array | null | undefined): void {
  if (!bytes) {
    return
  }

  transferables.push(bytes.buffer as ArrayBuffer)
}

function transferWorkerValue<T>(value: T, bytes: Array<Uint8Array | null | undefined>): T {
  const transferables: Transferable[] = []

  for (const candidate of bytes) {
    addTransferable(transferables, candidate)
  }

  if (transferables.length === 0) {
    return value
  }

  return transfer(value, transferables)
}

function isMetadataDocumentId(documentId: string): boolean {
  return documentId === ACCOUNT_METADATA_DOCUMENT_ID
}

function getInitialDocumentSnapshot(documentId: string): Record<string, unknown> {
  if (isMetadataDocumentId(documentId)) {
    return {}
  }

  return { id: documentId }
}

function pruneUndefinedDeepInPlace(value: unknown): void {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (value[index] === undefined) {
        value.splice(index, 1)
        continue
      }

      pruneUndefinedDeepInPlace(value[index])
    }
    return
  }

  if (!value || typeof value !== 'object') {
    return
  }

  const target = value as Record<string, unknown>
  for (const key of Object.keys(target)) {
    const nested = target[key]
    if (nested === undefined) {
      delete target[key]
      continue
    }

    pruneUndefinedDeepInPlace(nested)
  }
}

function normalizeSnapshot(input: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(input)
  pruneUndefinedDeepInPlace(normalized)
  return normalized
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function clonePatchValue(value: unknown): unknown {
  if (Array.isArray(value) || isPlainObject(value)) {
    return structuredClone(value)
  }

  return value
}

function syncDraftArray(target: unknown[], source: unknown[]): void {
  const sharedLength = Math.min(target.length, source.length)

  for (let index = 0; index < sharedLength; index += 1) {
    const sourceValue = source[index]
    const targetValue = target[index]

    if (Array.isArray(sourceValue)) {
      if (Array.isArray(targetValue)) {
        syncDraftArray(targetValue, sourceValue)
      } else {
        target[index] = structuredClone(sourceValue)
      }
      continue
    }

    if (isPlainObject(sourceValue)) {
      if (isPlainObject(targetValue)) {
        syncDraftObject(targetValue, sourceValue)
      } else {
        target[index] = structuredClone(sourceValue)
      }
      continue
    }

    if (!Object.is(targetValue, sourceValue)) {
      target[index] = sourceValue
    }
  }

  if (target.length > source.length) {
    target.splice(source.length)
  }

  for (let index = sharedLength; index < source.length; index += 1) {
    target.push(clonePatchValue(source[index]))
  }
}

function syncDraftObject(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) {
      delete target[key]
    }
  }

  for (const [key, sourceValue] of Object.entries(source)) {
    const targetValue = target[key]

    if (Array.isArray(sourceValue)) {
      if (Array.isArray(targetValue)) {
        syncDraftArray(targetValue, sourceValue)
      } else {
        target[key] = structuredClone(sourceValue)
      }
      continue
    }

    if (isPlainObject(sourceValue)) {
      if (isPlainObject(targetValue)) {
        syncDraftObject(targetValue, sourceValue)
      } else {
        target[key] = structuredClone(sourceValue)
      }
      continue
    }

    if (!Object.is(targetValue, sourceValue)) {
      target[key] = sourceValue
    }
  }
}

function serializeEntry(entry: WorkerEntry): WorkerSerializedEntry {
  return {
    doc: Automerge.save(entry.doc),
    syncState: Automerge.encodeSyncState(entry.syncState),
    cursor: entry.cursor,
  }
}

function extractSnapshot(doc: Automerge.Doc<Record<string, unknown>>): Record<string, unknown> {
  const snapshot = {
    ...(doc as unknown as Record<string, unknown>),
  }

  return structuredClone(snapshot)
}

function headsEqual(
  left: Automerge.Doc<Record<string, unknown>>,
  right: Automerge.Doc<Record<string, unknown>>,
): boolean {
  const leftHeads = Automerge.getHeads(left)
  const rightHeads = Automerge.getHeads(right)

  if (leftHeads.length !== rightHeads.length) {
    return false
  }

  for (let index = 0; index < leftHeads.length; index += 1) {
    if (leftHeads[index] !== rightHeads[index]) {
      return false
    }
  }

  return true
}

function toEntrySnapshot(documentId: string, entry: WorkerEntry): WorkerEntrySnapshot {
  return {
    documentId,
    serialized: serializeEntry(entry),
    snapshot: extractSnapshot(entry.doc),
  }
}

function decodeSyncState(syncState: Uint8Array): SyncState {
  return Automerge.decodeSyncState(syncState)
}

function loadPersistedRecord(record: PersistedWorkerRecord): WorkerEntrySnapshot | null {
  if (!record || typeof record.itemId !== 'string' || record.itemId.length === 0) {
    return null
  }

  try {
    const doc = Automerge.load<Record<string, unknown>>(record.doc)
    const syncState = decodeSyncState(record.syncState)
    const entry: WorkerEntry = {
      doc,
      syncState,
      cursor: typeof record.cursor === 'number' ? record.cursor : 0,
    }

    entriesByDocumentId.set(record.itemId, entry)
    return toEntrySnapshot(record.itemId, entry)
  } catch {
    entriesByDocumentId.delete(record.itemId)
    return null
  }
}

const workerApi = {
  reset(): void {
    entriesByDocumentId.clear()
  },

  initialize(records: PersistedWorkerRecord[]): WorkerEntrySnapshot[] {
    entriesByDocumentId.clear()

    const snapshots: WorkerEntrySnapshot[] = []
    for (const record of records) {
      const loaded = loadPersistedRecord(record)
      if (loaded) {
        snapshots.push(loaded)
      }
    }

    return transferWorkerValue(
      snapshots,
      snapshots.flatMap(snapshot => [snapshot.serialized.doc, snapshot.serialized.syncState]),
    )
  },

  loadPersistedRecord(record: PersistedWorkerRecord): WorkerEntrySnapshot | null {
    const loaded = loadPersistedRecord(record)
    if (!loaded) {
      return null
    }

    return transferWorkerValue(loaded, [
      loaded.serialized.doc,
      loaded.serialized.syncState,
    ])
  },

  exportAllBinaries(): Record<string, Uint8Array> {
    const documents: Record<string, Uint8Array> = {}
    const transferables: Transferable[] = []

    for (const [documentId, entry] of entriesByDocumentId) {
      if (isMetadataDocumentId(documentId)) {
        continue
      }

      const binary = Automerge.save(entry.doc)
      documents[documentId] = binary
      transferables.push(binary.buffer as ArrayBuffer)
    }

    if (transferables.length === 0) {
      return documents
    }

    return transfer(documents, transferables)
  },

  setSnapshot({ documentId, snapshot, cursor, syncState }: WorkerSetSnapshotInput): WorkerEntrySnapshot {
    const existing = entriesByDocumentId.get(documentId)
    const normalizedSnapshot = normalizeSnapshot(snapshot)
    const nextDoc = existing
      ? Automerge.change(existing.doc, draft => {
        syncDraftObject(draft as Record<string, unknown>, normalizedSnapshot)
      })
      : Automerge.from(normalizedSnapshot)

    const nextEntry: WorkerEntry = {
      doc: nextDoc,
      syncState: existing?.syncState
        || (syncState instanceof Uint8Array ? decodeSyncState(syncState) : Automerge.initSyncState()),
      cursor: Math.max(existing?.cursor ?? 0, typeof cursor === 'number' ? Math.max(0, cursor) : 0),
    }

    entriesByDocumentId.set(documentId, nextEntry)
    const nextSnapshot = toEntrySnapshot(documentId, nextEntry)
    return transferWorkerValue(nextSnapshot, [
      nextSnapshot.serialized.doc,
      nextSnapshot.serialized.syncState,
    ])
  },

  setBinary({ documentId, binary, cursor, syncState }: WorkerSetBinaryInput): WorkerEntrySnapshot {
    const existing = entriesByDocumentId.get(documentId)
    const loadedDoc = Automerge.load<Record<string, unknown>>(binary)

    const nextEntry: WorkerEntry = {
      doc: loadedDoc,
      syncState: existing?.syncState
        || (syncState instanceof Uint8Array ? decodeSyncState(syncState) : Automerge.initSyncState()),
      cursor: Math.max(existing?.cursor ?? 0, typeof cursor === 'number' ? Math.max(0, cursor) : 0),
    }

    entriesByDocumentId.set(documentId, nextEntry)
    const nextSnapshot = toEntrySnapshot(documentId, nextEntry)
    return transferWorkerValue(nextSnapshot, [
      nextSnapshot.serialized.doc,
      nextSnapshot.serialized.syncState,
    ])
  },

  receiveSyncMessage({ documentId, message, cursor, syncState }: WorkerReceiveMessageInput): WorkerReceiveSyncMessageResult {
    const existing = entriesByDocumentId.get(documentId)
    const baseDoc = existing?.doc || Automerge.from<Record<string, unknown>>(getInitialDocumentSnapshot(documentId))
    const baseSyncState = existing?.syncState
      || (syncState instanceof Uint8Array ? decodeSyncState(syncState) : Automerge.initSyncState())

    const [nextDoc, nextSyncState] = Automerge.receiveSyncMessage(baseDoc, baseSyncState, message)

    const nextEntry: WorkerEntry = {
      doc: nextDoc,
      syncState: nextSyncState,
      cursor: Math.max(existing?.cursor ?? 0, typeof cursor === 'number' ? Math.max(0, cursor) : 0),
    }

    entriesByDocumentId.set(documentId, nextEntry)

    const result = {
      ...toEntrySnapshot(documentId, nextEntry),
      changed: !headsEqual(baseDoc, nextDoc),
    }

    return transferWorkerValue(result, [
      result.serialized.doc,
      result.serialized.syncState,
    ])
  },

  createSyncMessage(documentId: string): WorkerCreateSyncMessageResult | null {
    const entry = entriesByDocumentId.get(documentId)
    if (!entry) {
      return null
    }

    const [nextSyncState, message] = Automerge.generateSyncMessage(entry.doc, entry.syncState)
    const result = {
      message,
      nextSyncState: Automerge.encodeSyncState(nextSyncState),
    }

    return transferWorkerValue(result, [
      result.message,
      result.nextSyncState,
    ])
  },

  commitSyncState({ documentId, syncState }: WorkerCommitSyncStateInput): WorkerSerializedEntry | null {
    const entry = entriesByDocumentId.get(documentId)
    if (!entry) {
      return null
    }

    entry.syncState = decodeSyncState(syncState)
    const serialized = serializeEntry(entry)
    return transferWorkerValue(serialized, [serialized.doc, serialized.syncState])
  },

  setCursor({ documentId, cursor }: WorkerSetCursorInput): WorkerSerializedEntry | null {
    const entry = entriesByDocumentId.get(documentId)
    if (!entry) {
      return null
    }

    entry.cursor = Math.max(entry.cursor, cursor)
    const serialized = serializeEntry(entry)
    return transferWorkerValue(serialized, [serialized.doc, serialized.syncState])
  },

  removeDocument(documentId: string): void {
    entriesByDocumentId.delete(documentId)
  },
}

expose(workerApi)

export type {
  PersistedWorkerRecord,
  WorkerCommitSyncStateInput,
  WorkerCreateSyncMessageResult,
  WorkerEntrySnapshot,
  WorkerReceiveMessageInput,
  WorkerReceiveSyncMessageResult,
  WorkerSerializedEntry,
  WorkerSetBinaryInput,
  WorkerSetCursorInput,
  WorkerSetSnapshotInput,
}
