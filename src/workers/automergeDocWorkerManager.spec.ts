import { beforeEach, describe, expect, it, vi } from 'vitest'

const wrapSpy = vi.hoisted(() => vi.fn())
const transferSpy = vi.hoisted(() => vi.fn((value: unknown, _?: Transferable[]) => value))
const listPersistedAutomergeDocsSpy = vi.hoisted(() => vi.fn())

vi.mock('comlink', () => ({
  wrap: wrapSpy,
  transfer: transferSpy,
}))

vi.mock('../sync/automergeDocStorage', () => ({
  listPersistedAutomergeDocs: listPersistedAutomergeDocsSpy,
}))

type MockWorkerInstance = {
  onerror: ((event: ErrorEvent) => void) | null
  terminate: ReturnType<typeof vi.fn>
}

type WorkerApi = {
  reset: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
  loadPersistedRecord: ReturnType<typeof vi.fn>
  exportAllBinaries: ReturnType<typeof vi.fn>
  setSnapshot: ReturnType<typeof vi.fn>
  setBinary: ReturnType<typeof vi.fn>
  receiveSyncMessage: ReturnType<typeof vi.fn>
  createSyncMessage: ReturnType<typeof vi.fn>
  commitSyncState: ReturnType<typeof vi.fn>
  setCursor: ReturnType<typeof vi.fn>
  removeDocument: ReturnType<typeof vi.fn>
}

const workerInstances: MockWorkerInstance[] = []
const workerConstructorSpy = vi.fn()
const workerApis: WorkerApi[] = []

class WorkerMock {
  onerror: ((event: ErrorEvent) => void) | null = null

  terminate = vi.fn()

  constructor() {
    workerConstructorSpy()
    workerInstances.push(this)
  }
}

function queueWorkerApi(api: WorkerApi): void {
  workerApis.push(api)
}

function createWorkerApi(overrides: Partial<WorkerApi> = {}): WorkerApi {
  return {
    reset: vi.fn(),
    initialize: vi.fn().mockResolvedValue([]),
    loadPersistedRecord: vi.fn().mockResolvedValue(null),
    exportAllBinaries: vi.fn().mockResolvedValue({}),
    setSnapshot: vi.fn(),
    setBinary: vi.fn(),
    receiveSyncMessage: vi.fn(),
    createSyncMessage: vi.fn().mockResolvedValue(null),
    commitSyncState: vi.fn().mockResolvedValue(null),
    setCursor: vi.fn().mockResolvedValue(null),
    removeDocument: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function createEntrySnapshot(documentId: string) {
  return {
    documentId,
    snapshot: {
      id: documentId,
      type: 'person',
      name: `Name ${documentId}`,
    },
    serialized: {
      doc: new Uint8Array([1, 2, 3]),
      syncState: new Uint8Array([4, 5, 6]),
      cursor: 0,
    },
  }
}

describe('automergeDocWorkerManager', () => {
  beforeEach(() => {
    workerInstances.length = 0
    workerApis.length = 0

    vi.clearAllMocks()
    vi.resetModules()

    wrapSpy.mockImplementation(() => {
      if (workerApis.length === 0) {
        throw new Error('Missing queued worker api')
      }

      return workerApis.shift()
    })

    listPersistedAutomergeDocsSpy.mockResolvedValue([])

    Object.defineProperty(globalThis, 'Worker', {
      value: WorkerMock,
      writable: true,
      configurable: true,
    })
  })

  it('uses one worker for offline edit bursts', async () => {
    const { setAutomergeWorkerSnapshot } = await import('./automergeDocWorkerManager')

    const setSnapshot = vi.fn().mockImplementation(({ documentId }) => createEntrySnapshot(documentId))

    queueWorkerApi(createWorkerApi({
      setSnapshot,
    }))

    const updates = ['item-1', 'item-2', 'item-3'].map(documentId => {
      return setAutomergeWorkerSnapshot({
        documentId,
        snapshot: {
          id: documentId,
          type: 'person',
          name: `Name ${documentId}`,
        },
      })
    })

    await expect(Promise.all(updates)).resolves.toHaveLength(3)
    expect(workerConstructorSpy).toHaveBeenCalledTimes(1)
    expect(setSnapshot).toHaveBeenCalledTimes(3)
  })

  it('rehydrates and retries after worker context loss', async () => {
    const {
      initializeAutomergeWorkerDocs,
      setAutomergeWorkerSnapshot,
    } = await import('./automergeDocWorkerManager')

    const account = 'account-1'
    const persistedRecords = [
      {
        itemId: 'item-1',
        doc: new Uint8Array([11, 12]),
        syncState: new Uint8Array([21, 22]),
        cursor: 7,
      },
    ]

    listPersistedAutomergeDocsSpy.mockResolvedValue(persistedRecords)

    const initialSetSnapshot = vi.fn().mockRejectedValue(new Error('MessagePort detached'))
    const firstApi = createWorkerApi({
      initialize: vi.fn().mockResolvedValue([]),
      setSnapshot: initialSetSnapshot,
    })

    const recoveredSnapshot = createEntrySnapshot('item-1')
    const recoveredSetSnapshot = vi.fn().mockResolvedValue(recoveredSnapshot)
    const recoveryInitialize = vi.fn().mockResolvedValue([])
    const recoveredApi = createWorkerApi({
      initialize: recoveryInitialize,
      setSnapshot: recoveredSetSnapshot,
    })

    queueWorkerApi(firstApi)
    queueWorkerApi(recoveredApi)

    await initializeAutomergeWorkerDocs(account, persistedRecords)

    await expect(setAutomergeWorkerSnapshot({
      documentId: 'item-1',
      snapshot: {
        id: 'item-1',
        type: 'person',
        name: 'Recovered',
      },
    })).resolves.toEqual(recoveredSnapshot)

    expect(workerConstructorSpy).toHaveBeenCalledTimes(2)
    expect(initialSetSnapshot).toHaveBeenCalledTimes(1)
    expect(workerInstances[0]?.terminate).toHaveBeenCalledTimes(1)
    expect(listPersistedAutomergeDocsSpy).toHaveBeenCalledWith(account)
    expect(recoveryInitialize).toHaveBeenCalledTimes(1)
    expect(recoveredSetSnapshot).toHaveBeenCalledTimes(1)
  })

  it('clones typed-array views before transferring sync payloads', async () => {
    const { receiveAutomergeWorkerSyncMessage } = await import('./automergeDocWorkerManager')

    const receiveResult = {
      ...createEntrySnapshot('item-1'),
      changed: true,
    }
    const receiveSyncMessage = vi.fn().mockResolvedValue(receiveResult)

    queueWorkerApi(createWorkerApi({
      receiveSyncMessage,
    }))

    const messageSource = new Uint8Array([10, 11, 12, 13, 14]).buffer
    const messageView = new Uint8Array(messageSource, 1, 3)
    const syncStateSource = new Uint8Array([20, 21, 22, 23]).buffer
    const syncStateView = new Uint8Array(syncStateSource, 1, 2)

    await expect(receiveAutomergeWorkerSyncMessage({
      documentId: 'item-1',
      message: messageView,
      syncState: syncStateView,
      cursor: 4,
    })).resolves.toEqual(receiveResult)

    const transferCall = transferSpy.mock.calls.find(call => {
      const candidate = call[0] as { documentId?: string } | undefined
      return candidate?.documentId === 'item-1'
    })

    expect(transferCall).toBeDefined()

    if (!transferCall) {
      throw new Error('Expected Comlink.transfer to be called with item payload')
    }

    const payload = transferCall[0] as {
      message: Uint8Array
      syncState?: Uint8Array
    }
    const transferables = (transferCall[1] || []) as Transferable[]

    expect(payload.message).not.toBe(messageView)
    expect(Array.from(payload.message)).toEqual(Array.from(messageView))
    expect(payload.message.byteOffset).toBe(0)
    expect(payload.message.byteLength).toBe(messageView.byteLength)

    expect(payload.syncState).toBeDefined()
    expect(payload.syncState).not.toBe(syncStateView)
    expect(Array.from(payload.syncState || [])).toEqual(Array.from(syncStateView))
    expect(payload.syncState?.byteOffset).toBe(0)
    expect(payload.syncState?.byteLength).toBe(syncStateView.byteLength)

    expect(transferables).toContain(payload.message.buffer)
    expect(transferables).toContain(payload.syncState?.buffer as ArrayBuffer)
  })
})
