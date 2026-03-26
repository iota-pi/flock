import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockWorkerInstance = {
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  postMessage: ReturnType<typeof vi.fn>
}

const workerInstances: MockWorkerInstance[] = []
const workerConstructorSpy = vi.fn()

class WorkerMock {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage = vi.fn()

  constructor() {
    workerConstructorSpy()
    workerInstances.push(this)
  }
}

describe('itemWorkerManager', () => {
  beforeEach(() => {
    workerInstances.length = 0
    vi.clearAllMocks()
    vi.resetModules()
    Object.defineProperty(globalThis, 'Worker', {
      value: WorkerMock,
      writable: true,
      configurable: true,
    })
  })

  it('reuses a single Worker for rapid requests and resolves by job id', async () => {
    const { processItemsWithWorker } = await import('./itemWorkerManager')

    const request = {
      items: [],
      filters: [],
      sortCriteria: [],
      showArchived: false,
    }

    const promiseOne = processItemsWithWorker(request)
    const promiseTwo = processItemsWithWorker(request)
    const promiseThree = processItemsWithWorker(request)

    expect(workerConstructorSpy).toHaveBeenCalledTimes(1)
    expect(workerInstances).toHaveLength(1)

    const firstWorker = workerInstances[0]
    const postedMessages = firstWorker.postMessage.mock.calls.map(call => call[0]) as Array<{ jobId: number }>

    expect(postedMessages).toHaveLength(3)

    firstWorker.onmessage?.({
      data: {
        jobId: postedMessages[1].jobId,
        results: [{ id: 'second' }],
        totalApplicable: 2,
        archivedCount: 0,
      },
    } as MessageEvent)

    firstWorker.onmessage?.({
      data: {
        jobId: postedMessages[0].jobId,
        results: [{ id: 'first' }],
        totalApplicable: 1,
        archivedCount: 0,
      },
    } as MessageEvent)

    firstWorker.onmessage?.({
      data: {
        jobId: postedMessages[2].jobId,
        results: [{ id: 'third' }],
        totalApplicable: 3,
        archivedCount: 1,
      },
    } as MessageEvent)

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

  it('rejects pending jobs on worker error and resets worker reference', async () => {
    const { processItemsWithWorker } = await import('./itemWorkerManager')

    const request = {
      items: [],
      filters: [],
      sortCriteria: [],
      showArchived: false,
    }

    const pendingOne = processItemsWithWorker(request)
    const pendingTwo = processItemsWithWorker(request)

    expect(workerConstructorSpy).toHaveBeenCalledTimes(1)
    const firstWorker = workerInstances[0]

    firstWorker.onerror?.({ message: 'worker crashed' } as ErrorEvent)

    await expect(pendingOne).rejects.toThrow('worker crashed')
    await expect(pendingTwo).rejects.toThrow('worker crashed')

    const recoveryPromise = processItemsWithWorker(request)
    expect(workerConstructorSpy).toHaveBeenCalledTimes(2)

    const secondWorker = workerInstances[1]
    const recoveryJobId = secondWorker.postMessage.mock.calls[0][0].jobId
    secondWorker.onmessage?.({
      data: {
        jobId: recoveryJobId,
        results: [],
        totalApplicable: 0,
        archivedCount: 0,
      },
    } as MessageEvent)

    await expect(recoveryPromise).resolves.toEqual({
      results: [],
      totalApplicable: 0,
      archivedCount: 0,
    })
  })
})