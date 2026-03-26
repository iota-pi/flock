import type { Item } from '../state/items'
import type { FilterCriterion } from '../utils/customFilter'
import type { SortCriterion } from '../utils/customSort'

type WorkerRequest = {
  jobId: number
  items: Item[]
  filters: FilterCriterion[]
  sortCriteria: SortCriterion[]
  showArchived: boolean
}

type WorkerResponse = {
  jobId: number
  results: Item[]
  totalApplicable: number
  archivedCount: number
}

let worker: Worker | null = null
let nextJobId = 0

const pendingJobs = new Map<number, {
  resolve: (value: Omit<WorkerResponse, 'jobId'>) => void
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
    const payload = event.data as WorkerResponse
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
    pendingJobs.clear()
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
      jobId,
      ...input,
    } satisfies WorkerRequest)
  })
}
