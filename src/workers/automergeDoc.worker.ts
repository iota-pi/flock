import * as Automerge from '@automerge/automerge'
import { expose } from 'comlink'

const ACCOUNT_METADATA_DOCUMENT_ID = '__account_metadata__'

type SyncState = ReturnType<typeof Automerge.initSyncState>

type PersistedWorkerRecord = {
  itemId: string
  doc: string
  syncState: string
  cursor?: number
}

type WorkerSerializedEntry = {
  doc: string
  syncState: string
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
  nextSyncState: string
}

type WorkerSetSnapshotInput = {
  documentId: string
  snapshot: Record<string, unknown>
  cursor?: number
  syncState?: string
}

type WorkerReceiveMessageInput = {
  documentId: string
  message: Uint8Array
  cursor?: number
  syncState?: string
}

type WorkerCommitSyncStateInput = {
  documentId: string
  syncState: string
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

function decodeBase64ToBytes(value: string): Uint8Array {
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index)
  }
  return bytes
}

function encodeBytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode(...chunk)
  }

  return btoa(binary)
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

function serializeEntry(entry: WorkerEntry): WorkerSerializedEntry {
  return {
    doc: encodeBytesToBase64(Automerge.save(entry.doc)),
    syncState: encodeBytesToBase64(Automerge.encodeSyncState(entry.syncState)),
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

function decodeSyncState(syncState: string): SyncState {
  return Automerge.decodeSyncState(decodeBase64ToBytes(syncState))
}

function loadPersistedRecord(record: PersistedWorkerRecord): WorkerEntrySnapshot | null {
  if (!record || typeof record.itemId !== 'string' || record.itemId.length === 0) {
    return null
  }

  try {
    const doc = Automerge.load<Record<string, unknown>>(decodeBase64ToBytes(record.doc))
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

    return snapshots
  },

  loadPersistedRecord(record: PersistedWorkerRecord): WorkerEntrySnapshot | null {
    return loadPersistedRecord(record)
  },

  setSnapshot({ documentId, snapshot, cursor, syncState }: WorkerSetSnapshotInput): WorkerEntrySnapshot {
    const existing = entriesByDocumentId.get(documentId)
    const normalizedSnapshot = normalizeSnapshot(snapshot)
    const nextDoc = existing
      ? Automerge.change(existing.doc, draft => {
        for (const key of Object.keys(draft)) {
          delete (draft as Record<string, unknown>)[key]
        }

        Object.assign(draft as Record<string, unknown>, normalizedSnapshot)
        pruneUndefinedDeepInPlace(draft)
      })
      : Automerge.from(normalizedSnapshot)

    const nextEntry: WorkerEntry = {
      doc: nextDoc,
      syncState: existing?.syncState
        || (typeof syncState === 'string' ? decodeSyncState(syncState) : Automerge.initSyncState()),
      cursor: existing?.cursor ?? (typeof cursor === 'number' ? Math.max(0, cursor) : 0),
    }

    entriesByDocumentId.set(documentId, nextEntry)
    return toEntrySnapshot(documentId, nextEntry)
  },

  receiveSyncMessage({ documentId, message, cursor, syncState }: WorkerReceiveMessageInput): WorkerReceiveSyncMessageResult {
    const existing = entriesByDocumentId.get(documentId)
    const baseDoc = existing?.doc || Automerge.from<Record<string, unknown>>(getInitialDocumentSnapshot(documentId))
    const baseSyncState = existing?.syncState
      || (typeof syncState === 'string' ? decodeSyncState(syncState) : Automerge.initSyncState())

    const [nextDoc, nextSyncState] = Automerge.receiveSyncMessage(baseDoc, baseSyncState, message)

    const nextEntry: WorkerEntry = {
      doc: nextDoc,
      syncState: nextSyncState,
      cursor: existing?.cursor ?? (typeof cursor === 'number' ? Math.max(0, cursor) : 0),
    }

    entriesByDocumentId.set(documentId, nextEntry)

    return {
      ...toEntrySnapshot(documentId, nextEntry),
      changed: !headsEqual(baseDoc, nextDoc),
    }
  },

  createSyncMessage(documentId: string): WorkerCreateSyncMessageResult | null {
    const entry = entriesByDocumentId.get(documentId)
    if (!entry) {
      return null
    }

    const [nextSyncState, message] = Automerge.generateSyncMessage(entry.doc, entry.syncState)
    return {
      message,
      nextSyncState: encodeBytesToBase64(Automerge.encodeSyncState(nextSyncState)),
    }
  },

  commitSyncState({ documentId, syncState }: WorkerCommitSyncStateInput): WorkerSerializedEntry | null {
    const entry = entriesByDocumentId.get(documentId)
    if (!entry) {
      return null
    }

    entry.syncState = decodeSyncState(syncState)
    return serializeEntry(entry)
  },

  setCursor({ documentId, cursor }: WorkerSetCursorInput): WorkerSerializedEntry | null {
    const entry = entriesByDocumentId.get(documentId)
    if (!entry) {
      return null
    }

    entry.cursor = Math.max(entry.cursor, cursor)
    return serializeEntry(entry)
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
  WorkerSetCursorInput,
  WorkerSetSnapshotInput,
}
