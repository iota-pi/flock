import { beforeEach, describe, expect, it, vi } from 'vitest'

const wrapSpy = vi.hoisted(() => vi.fn())

vi.mock('comlink', () => ({
  wrap: wrapSpy,
}))

type MockWorkerInstance = {
  onerror: ((event: ErrorEvent) => void) | null
}

const workerInstances: MockWorkerInstance[] = []
const workerConstructorSpy = vi.fn()

class WorkerMock {
  onerror: ((event: ErrorEvent) => void) | null = null

  constructor() {
    workerConstructorSpy()
    workerInstances.push(this)
  }
}

type ItemWorkerApi = {
  processItems: ReturnType<typeof vi.fn>
  seedAutomerge: ReturnType<typeof vi.fn>
}

const workerApis: ItemWorkerApi[] = []

function queueWorkerApi(api: ItemWorkerApi): void {
  workerApis.push(api)
}

function createWorkerRequest() {
  return {
    items: Array.from({ length: 120 }, (_, index) => ({
      id: `item-${index}`,
      archived: false,
    } as any)),
    filters: [],
    sortCriteria: [],
    showArchived: false,
  }
}

describe('itemWorkerManager', () => {
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

    Object.defineProperty(globalThis, 'Worker', {
      value: WorkerMock,
      writable: true,
      configurable: true,
    })
  })

  it('reuses a single Worker for rapid requests', async () => {
    const { processItemsWithWorker } = await import('./itemWorkerManager')

    const processItems = vi.fn()
      .mockResolvedValueOnce({
        results: [{ id: 'first' }],
        totalApplicable: 1,
        archivedCount: 0,
      })
      .mockResolvedValueOnce({
        results: [{ id: 'second' }],
        totalApplicable: 2,
        archivedCount: 0,
      })
      .mockResolvedValueOnce({
        results: [{ id: 'third' }],
        totalApplicable: 3,
        archivedCount: 1,
      })

    queueWorkerApi({
      processItems,
      seedAutomerge: vi.fn(),
    })

    const request = createWorkerRequest()

    const promiseOne = processItemsWithWorker(request)
    const promiseTwo = processItemsWithWorker(request)
    const promiseThree = processItemsWithWorker(request)

    expect(workerConstructorSpy).toHaveBeenCalledTimes(1)
    expect(workerInstances).toHaveLength(1)
    expect(processItems).toHaveBeenCalledTimes(3)
    expect(processItems).toHaveBeenNthCalledWith(1, request)
    expect(processItems).toHaveBeenNthCalledWith(2, request)
    expect(processItems).toHaveBeenNthCalledWith(3, request)

    await expect(promiseOne).resolves.toEqual({
      results: [{ id: 'first' }],
      totalApplicable: 1,
      archivedCount: 0,
    })
    await expect(promiseTwo).resolves.toEqual({
      results: [{ id: 'second' }],
      totalApplicable: 2,
      archivedCount: 0,
    })
    await expect(promiseThree).resolves.toEqual({
      results: [{ id: 'third' }],
      totalApplicable: 3,
      archivedCount: 1,
    })
  })

  it('resets cached worker api on worker error', async () => {
    const { processItemsWithWorker } = await import('./itemWorkerManager')

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // suppress expected worker error logs during test
    })

    queueWorkerApi({
      processItems: vi.fn().mockResolvedValue({
        results: [],
        totalApplicable: 0,
        archivedCount: 0,
      }),
      seedAutomerge: vi.fn(),
    })

    queueWorkerApi({
      processItems: vi.fn().mockResolvedValue({
        results: [{ id: 'recovered' }],
        totalApplicable: 1,
        archivedCount: 0,
      }),
      seedAutomerge: vi.fn(),
    })

    const request = createWorkerRequest()

    await expect(processItemsWithWorker(request)).resolves.toEqual({
      results: [],
      totalApplicable: 0,
      archivedCount: 0,
    })

    expect(workerConstructorSpy).toHaveBeenCalledTimes(1)
    const firstWorker = workerInstances[0]

    firstWorker.onerror?.({ message: 'worker crashed' } as ErrorEvent)

    const recoveryPromise = processItemsWithWorker(request)
    expect(workerConstructorSpy).toHaveBeenCalledTimes(2)

    await expect(recoveryPromise).resolves.toEqual({
      results: [{ id: 'recovered' }],
      totalApplicable: 1,
      archivedCount: 0,
    })

    consoleSpy.mockRestore()
  })

  it('seeds automerge binaries via Comlink worker api', async () => {
    const { seedAutomergeBinaryWithWorker } = await import('./itemWorkerManager')

    const seedAutomerge = vi.fn().mockResolvedValue([
      { id: 'item-1', binary: new Uint8Array([1, 2, 3]) },
    ])

    queueWorkerApi({
      processItems: vi.fn(),
      seedAutomerge,
    })

    const promise = seedAutomergeBinaryWithWorker([
      { id: 'item-1' } as any,
    ])

    expect(workerConstructorSpy).toHaveBeenCalledTimes(1)
    expect(seedAutomerge).toHaveBeenCalledTimes(1)

    await expect(promise).resolves.toEqual([{ id: 'item-1', binary: new Uint8Array([1, 2, 3]) }])
  })
})