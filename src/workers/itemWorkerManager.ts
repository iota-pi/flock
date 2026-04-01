import type { Item } from '../state/items'
import type { FilterCriterion } from '../utils/customFilter'
import type { SortCriterion } from '../utils/customSort'

type WorkerRequest = {
  jobId: number
  type?: 'PROCESS_ITEMS'
  items: Item[]
  filters: FilterCriterion[]
  sortCriteria: SortCriterion[]
  showArchived: boolean
}

type SeedAutomergeRequest = {
  jobId: number
  type: 'SEED_AUTOMERGE'
  items: Item[]
}

type WorkerResponse = {
  jobId: number
  type?: 'PROCESS_ITEMS'
  results: Item[]
  totalApplicable: number
  archivedCount: number
}

type SeedAutomergeResponse = {
  jobId: number
  type: 'SEED_AUTOMERGE'
  seeded: Array<{
    id: string
    binary: Uint8Array
  }>
}

let worker: Worker | null = null
let nextJobId = 0

const pendingJobs = new Map<number, {
  resolve: (value: Omit<WorkerResponse, 'jobId'>) => void
  reject: (reason?: unknown) => void
}>()

const pendingSeedJobs = new Map<number, {
  resolve: (value: SeedAutomergeResponse['seeded']) => void
  reject: (reason?: unknown) => void
}>()

function getWorker() {
  if (worker) {
    return worker
  }

  worker = new Worker(new URL('./item.worker.ts', import.meta.url), {
    type: 'module',
  })

  worker.onmessage = event => {
    const payload = event.data as WorkerResponse | SeedAutomergeResponse

    if (payload.type === 'SEED_AUTOMERGE') {
      const pendingSeed = pendingSeedJobs.get(payload.jobId)
      if (!pendingSeed) {
        return
      }

      pendingSeedJobs.delete(payload.jobId)
      pendingSeed.resolve(payload.seeded)
      return
    }

    const pending = pendingJobs.get(payload.jobId)
    if (!pending) {
      return
    }

    pendingJobs.delete(payload.jobId)
    pending.resolve({
      results: payload.results,
      totalApplicable: payload.totalApplicable,
      archivedCount: payload.archivedCount,
    })
  }

  worker.onerror = event => {
    const error = new Error(event.message || 'Item worker failed')
    for (const pending of pendingJobs.values()) {
      pending.reject(error)
    }
    for (const pending of pendingSeedJobs.values()) {
      pending.reject(error)
    }
    pendingJobs.clear()
    pendingSeedJobs.clear()
    worker = null
  }

  return worker
}

export async function processItemsWithWorker(input: Omit<WorkerRequest, 'jobId'>): Promise<Omit<WorkerResponse, 'jobId'>> {
  const activeWorker = getWorker()
  nextJobId += 1
  const jobId = nextJobId

  return new Promise((resolve, reject) => {
    pendingJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      type: 'PROCESS_ITEMS',
      jobId,
      ...input,
    } satisfies WorkerRequest)
  })
}

export async function seedAutomergeBinaryWithWorker(items: Item[]): Promise<Array<{ id: string; binary: Uint8Array }>> {
  if (items.length === 0) {
    return []
  }

  const activeWorker = getWorker()
  nextJobId += 1
  const jobId = nextJobId

  return new Promise((resolve, reject) => {
    pendingSeedJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      type: 'SEED_AUTOMERGE',
      jobId,
      items,
    } satisfies SeedAutomergeRequest)
  })
}
