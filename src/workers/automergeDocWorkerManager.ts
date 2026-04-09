import { wrap, type Remote } from 'comlink'
import type {
  PersistedWorkerRecord,
  WorkerCommitSyncStateInput,
  WorkerCreateSyncMessageResult,
  WorkerEntrySnapshot,
  WorkerReceiveMessageInput,
  WorkerReceiveSyncMessageResult,
  WorkerSerializedEntry,
  WorkerSetCursorInput,
  WorkerSetSnapshotInput,
} from './automergeDoc.worker'

type AutomergeDocWorkerApi = {
  reset: () => void
  initialize: (records: PersistedWorkerRecord[]) => WorkerEntrySnapshot[]
  loadPersistedRecord: (record: PersistedWorkerRecord) => WorkerEntrySnapshot | null
  setSnapshot: (input: WorkerSetSnapshotInput) => WorkerEntrySnapshot
  receiveSyncMessage: (input: WorkerReceiveMessageInput) => WorkerReceiveSyncMessageResult
  createSyncMessage: (documentId: string) => WorkerCreateSyncMessageResult | null
  commitSyncState: (input: WorkerCommitSyncStateInput) => WorkerSerializedEntry | null
  setCursor: (input: WorkerSetCursorInput) => WorkerSerializedEntry | null
  removeDocument: (documentId: string) => void
}

let worker: Worker | null = null
let workerApi: Remote<AutomergeDocWorkerApi> | null = null

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

    workerApi = wrap<AutomergeDocWorkerApi>(worker)
    return workerApi
  } catch (error) {
    resetWorker('Failed to initialize automerge document worker', error)
    throw error
  }
}

async function withWorker<T>(run: (api: Remote<AutomergeDocWorkerApi>) => Promise<T>): Promise<T> {
  const api = getWorkerApi()
  try {
    return await run(api)
  } catch (error) {
    resetWorker('Automerge document worker execution failed', error)
    throw error
  }
}

export async function resetAutomergeDocWorker(): Promise<void> {
  if (!workerApi) {
    return
  }

  try {
    await workerApi.reset()
  } finally {
    disposeWorker()
  }
}

export function initializeAutomergeWorkerDocs(records: PersistedWorkerRecord[]): Promise<WorkerEntrySnapshot[]> {
  return withWorker(api => api.initialize(records))
}

export function loadAutomergeWorkerRecord(record: PersistedWorkerRecord): Promise<WorkerEntrySnapshot | null> {
  return withWorker(api => api.loadPersistedRecord(record))
}

export function setAutomergeWorkerSnapshot(input: WorkerSetSnapshotInput): Promise<WorkerEntrySnapshot> {
  return withWorker(api => api.setSnapshot(input))
}

export function receiveAutomergeWorkerSyncMessage(
  input: WorkerReceiveMessageInput,
): Promise<WorkerReceiveSyncMessageResult> {
  return withWorker(api => api.receiveSyncMessage(input))
}

export function createAutomergeWorkerSyncMessage(documentId: string): Promise<WorkerCreateSyncMessageResult | null> {
  return withWorker(api => api.createSyncMessage(documentId))
}

export function commitAutomergeWorkerSyncState(input: WorkerCommitSyncStateInput): Promise<WorkerSerializedEntry | null> {
  return withWorker(api => api.commitSyncState(input))
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
  WorkerEntrySnapshot,
  WorkerSerializedEntry,
}
