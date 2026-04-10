import * as Comlink from 'comlink'
import type { Remote } from 'comlink'
import { listPersistedAutomergeDocs, type PersistedDocRecord } from '../sync/automergeDocStorage'
import type {
  WorkerApplyDocumentPatchesInput,
  PersistedWorkerRecord,
  WorkerCommitSyncStateInput,
  WorkerCreateSyncMessageResult,
  WorkerDocumentPatch,
  WorkerEntrySnapshot,
  WorkerReceiveMessageInput,
  WorkerReceiveSyncMessageResult,
  WorkerSerializedEntry,
  WorkerSetBinaryInput,
  WorkerSetCursorInput,
  WorkerSetSnapshotInput,
} from './automergeDoc.worker'

type AutomergeDocWorkerApi = {
  reset: () => void
  initialize: (records: PersistedWorkerRecord[]) => WorkerEntrySnapshot[]
  loadPersistedRecord: (record: PersistedWorkerRecord) => WorkerEntrySnapshot | null
  mergePersistedRecord: (record: PersistedWorkerRecord) => WorkerEntrySnapshot | null
  exportAllBinaries: () => Record<string, Uint8Array>
  setSnapshot: (input: WorkerSetSnapshotInput) => WorkerEntrySnapshot
  applyDocumentPatches: (input: WorkerApplyDocumentPatchesInput) => WorkerEntrySnapshot
  setBinary: (input: WorkerSetBinaryInput) => WorkerEntrySnapshot
  receiveSyncMessage: (input: WorkerReceiveMessageInput) => WorkerReceiveSyncMessageResult
  createSyncMessage: (documentId: string) => WorkerCreateSyncMessageResult | null
  commitSyncState: (input: WorkerCommitSyncStateInput) => WorkerSerializedEntry | null
  setCursor: (input: WorkerSetCursorInput) => WorkerSerializedEntry | null
  removeDocument: (documentId: string) => void
}

let worker: Worker | null = null
let workerApi: Remote<AutomergeDocWorkerApi> | null = null
let activeAccount: string | null = null

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

function cloneTransferBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value)
}

function toPersistedWorkerRecord(value: PersistedDocRecord): PersistedWorkerRecord {
  return {
    itemId: value.itemId,
    doc: asUint8Array(value.doc),
    syncState: asUint8Array(value.syncState),
    cursor: value.cursor,
  }
}

function toTransferRecord(record: PersistedWorkerRecord): PersistedWorkerRecord {
  return {
    ...record,
    doc: cloneTransferBytes(record.doc),
    syncState: cloneTransferBytes(record.syncState),
  }
}

function toTransferRecords(records: PersistedWorkerRecord[]): PersistedWorkerRecord[] {
  return records.map(record => toTransferRecord(record))
}

function collectRecordTransferables(records: PersistedWorkerRecord[]): Transferable[] {
  const transferables: Transferable[] = []

  for (const record of records) {
    transferables.push(record.doc.buffer as ArrayBuffer)
    transferables.push(record.syncState.buffer as ArrayBuffer)
  }

  return transferables
}

function disposeWorker(): void {
  ;(worker as { terminate?: () => void } | null)?.terminate?.()
  worker = null
  workerApi = null
}

function resetWorker(reason: string, error?: unknown): void {
  if (error) {
    console.error(reason, error)
  } else {
    console.error(reason)
  }

  disposeWorker()
}

function getWorkerApi(): Remote<AutomergeDocWorkerApi> {
  if (workerApi) {
    return workerApi
  }

  try {
    worker = new Worker(new URL('./automergeDoc.worker.ts', import.meta.url), {
      type: 'module',
    })

    worker.onerror = event => {
      resetWorker(event.message || 'Automerge document worker failed')
    }

    workerApi = Comlink.wrap<AutomergeDocWorkerApi>(worker)
    return workerApi
  } catch (error) {
    resetWorker('Failed to initialize automerge document worker', error)
    throw error
  }
}

function isWorkerContextLostError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /terminated|context.*lost|messageport|detached|worker.*failed|invalidstateerror/i.test(message)
}

async function rehydrateWorker(): Promise<boolean> {
  const account = activeAccount
  if (!account) {
    return false
  }

  try {
    disposeWorker()
    const api = getWorkerApi()
    const persisted = await listPersistedAutomergeDocs(account)
    const records = toTransferRecords(persisted.map(toPersistedWorkerRecord))
    const transferables = collectRecordTransferables(records)

    await api.initialize(Comlink.transfer(records, transferables))
    return true
  } catch (error) {
    resetWorker('Failed to rehydrate automerge document worker after context loss', error)
    return false
  }
}

async function withWorker<T>(run: (api: Remote<AutomergeDocWorkerApi>) => Promise<T>): Promise<T> {
  const api = getWorkerApi()

  try {
    return await run(api)
  } catch (error) {
    if (isWorkerContextLostError(error) && await rehydrateWorker()) {
      const recoveredApi = getWorkerApi()
      try {
        return await run(recoveredApi)
      } catch (retryError) {
        resetWorker('Automerge document worker retry failed after recovery', retryError)
        throw retryError
      }
    }

    resetWorker('Automerge document worker execution failed', error)
    throw error
  }
}

export async function resetAutomergeDocWorker(): Promise<void> {
  activeAccount = null

  if (!workerApi) {
    return
  }

  try {
    await workerApi.reset()
  } finally {
    disposeWorker()
  }
}

export function initializeAutomergeWorkerDocs(account: string, records: PersistedWorkerRecord[]): Promise<WorkerEntrySnapshot[]> {
  activeAccount = account
  const transferRecords = toTransferRecords(records)
  const transferables = collectRecordTransferables(transferRecords)
  return withWorker(api => api.initialize(Comlink.transfer(transferRecords, transferables)))
}

export function loadAutomergeWorkerRecord(record: PersistedWorkerRecord): Promise<WorkerEntrySnapshot | null> {
  const transferRecord = toTransferRecord(record)
  const transferables: Transferable[] = [
    transferRecord.doc.buffer as ArrayBuffer,
    transferRecord.syncState.buffer as ArrayBuffer,
  ]

  return withWorker(api => api.loadPersistedRecord(Comlink.transfer(transferRecord, transferables)))
}

export function mergeAutomergeWorkerRecord(record: PersistedWorkerRecord): Promise<WorkerEntrySnapshot | null> {
  const transferRecord = toTransferRecord(record)
  const transferables: Transferable[] = [
    transferRecord.doc.buffer as ArrayBuffer,
    transferRecord.syncState.buffer as ArrayBuffer,
  ]

  return withWorker(api => api.mergePersistedRecord(Comlink.transfer(transferRecord, transferables)))
}

export function exportAutomergeWorkerBinaries(): Promise<Record<string, Uint8Array>> {
  return withWorker(api => api.exportAllBinaries())
}

export function setAutomergeWorkerSnapshot(input: WorkerSetSnapshotInput): Promise<WorkerEntrySnapshot> {
  const payload: WorkerSetSnapshotInput = input.syncState instanceof Uint8Array
    ? {
      ...input,
      syncState: cloneTransferBytes(input.syncState),
    }
    : input

  const transferables: Transferable[] = []
  if (payload.syncState instanceof Uint8Array) {
    transferables.push(payload.syncState.buffer as ArrayBuffer)
  }

  const transferredPayload = transferables.length > 0
    ? Comlink.transfer(payload, transferables)
    : payload

  return withWorker(api => api.setSnapshot(transferredPayload))
}

export function applyAutomergeWorkerPatches(input: WorkerApplyDocumentPatchesInput): Promise<WorkerEntrySnapshot> {
  return withWorker(api => api.applyDocumentPatches(input))
}

export function setAutomergeWorkerBinary(input: WorkerSetBinaryInput): Promise<WorkerEntrySnapshot> {
  const payload: WorkerSetBinaryInput = {
    ...input,
    binary: cloneTransferBytes(input.binary),
    syncState: input.syncState instanceof Uint8Array
      ? cloneTransferBytes(input.syncState)
      : input.syncState,
  }

  const transferables: Transferable[] = [payload.binary.buffer as ArrayBuffer]
  if (payload.syncState instanceof Uint8Array) {
    transferables.push(payload.syncState.buffer as ArrayBuffer)
  }

  return withWorker(api => api.setBinary(Comlink.transfer(payload, transferables)))
}

export function receiveAutomergeWorkerSyncMessage(
  input: WorkerReceiveMessageInput,
): Promise<WorkerReceiveSyncMessageResult> {
  const payload: WorkerReceiveMessageInput = {
    ...input,
    message: cloneTransferBytes(input.message),
    syncState: input.syncState instanceof Uint8Array
      ? cloneTransferBytes(input.syncState)
      : input.syncState,
  }

  const transferables: Transferable[] = [payload.message.buffer as ArrayBuffer]
  if (payload.syncState instanceof Uint8Array) {
    transferables.push(payload.syncState.buffer as ArrayBuffer)
  }

  return withWorker(api => api.receiveSyncMessage(Comlink.transfer(payload, transferables)))
}

export function createAutomergeWorkerSyncMessage(documentId: string): Promise<WorkerCreateSyncMessageResult | null> {
  return withWorker(api => api.createSyncMessage(documentId))
}

export function commitAutomergeWorkerSyncState(input: WorkerCommitSyncStateInput): Promise<WorkerSerializedEntry | null> {
  const payload: WorkerCommitSyncStateInput = {
    ...input,
    syncState: cloneTransferBytes(input.syncState),
  }
  const transferables: Transferable[] = [payload.syncState.buffer as ArrayBuffer]
  return withWorker(api => api.commitSyncState(Comlink.transfer(payload, transferables)))
}

export function setAutomergeWorkerCursor(input: WorkerSetCursorInput): Promise<WorkerSerializedEntry | null> {
  return withWorker(api => api.setCursor(input))
}

export function removeAutomergeWorkerDocument(documentId: string): Promise<void> {
  return withWorker(async api => {
    await api.removeDocument(documentId)
  })
}

export type {
  PersistedWorkerRecord,
  WorkerApplyDocumentPatchesInput,
  WorkerDocumentPatch,
  WorkerEntrySnapshot,
  WorkerSerializedEntry,
}
