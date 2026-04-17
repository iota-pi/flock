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

  it('processItemsSnapshot respects archived filters without showArchived toggles', async () => {
    const { processItemsSnapshot } = await import('./itemWorkerManager')

    const result = processItemsSnapshot({
      items: [
        { id: 'person-1', archived: false, name: 'Alice' } as any,
        { id: 'person-2', archived: true, name: 'Archived Alice' } as any,
      ],
      filters: [
        {
          type: 'archived',
          baseOperator: 'is',
          inverse: false,
          operator: 'is',
          value: false,
        },
      ],
      sortCriteria: [],
    })

    expect(result.totalApplicable).toBe(2)
    expect(result.archivedCount).toBe(1)
    expect(result.results).toHaveLength(1)
    expect(result.results[0]?.id).toBe('person-1')
  })
})