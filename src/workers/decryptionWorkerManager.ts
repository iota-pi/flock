import type { VaultBranch } from '../shared/itemTypes'

type ResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

type ResolveConflictRequest = {
  type: 'RESOLVE_QUEUE_CONFLICT'
  jobId: number
  key: CryptoKey
  itemId: string
  localBranches: ResolvedBranch[]
  serverBranches: ResolvedBranch[]
}

type RescueStaleBranchRequest = {
  type: 'RESCUE_STALE_COMPACTED_BRANCH'
  jobId: number
  key: CryptoKey
  itemId: string
  localBranch: ResolvedBranch
  serverBranch: ResolvedBranch
}

type WorkerResponse = {
  type?: string
  jobId?: number
  itemId?: string
  resolvedBranch?: ResolvedBranch
  rescuedBranch?: ResolvedBranch
}

let worker: Worker | null = null
let nextJobId = 0

const pendingJobs = new Map<number, {
  resolve: (value: any) => void
  reject: (reason?: unknown) => void
}>()

function getWorker() {
  if (worker) {
    return worker
  }

  worker = new Worker(new URL('./decryption.worker.ts', import.meta.url), {
    type: 'module',
  })

  worker.onmessage = event => {
    const payload = event.data as WorkerResponse
    if (typeof payload.jobId !== 'number') {
      return
    }

    const pending = pendingJobs.get(payload.jobId)
    if (!pending) {
      return
    }

    pendingJobs.delete(payload.jobId)

    if (payload.type === 'QUEUE_CONFLICT_RESOLVED' && payload.resolvedBranch) {
      pending.resolve(payload.resolvedBranch)
      return
    }

    if (payload.type === 'STALE_COMPACTED_BRANCH_RESCUED' && payload.rescuedBranch) {
      pending.resolve(payload.rescuedBranch)
      return
    }

    pending.reject(new Error('Unexpected decryption worker response'))
  }

  worker.onerror = event => {
    const error = new Error(event.message || 'Decryption worker failed')
    for (const pending of pendingJobs.values()) {
      pending.reject(error)
    }
    pendingJobs.clear()
    worker = null
  }

  return worker
}

function postResolveConflictRequest(request: Omit<ResolveConflictRequest, 'jobId'>): Promise<ResolvedBranch> {
  const activeWorker = getWorker()
  nextJobId += 1
  const jobId = nextJobId

  return new Promise<ResolvedBranch>((resolve, reject) => {
    pendingJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      ...request,
      jobId,
    })
  })
}

function postRescueStaleBranchRequest(request: Omit<RescueStaleBranchRequest, 'jobId'>): Promise<ResolvedBranch> {
  const activeWorker = getWorker()
  nextJobId += 1
  const jobId = nextJobId

  return new Promise<ResolvedBranch>((resolve, reject) => {
    pendingJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      ...request,
      jobId,
    })
  })
}

export async function resolveQueueConflictInWorker(input: {
  key: CryptoKey
  itemId: string
  localBranches: VaultBranch[]
  serverBranches: VaultBranch[]
}): Promise<ResolvedBranch> {
  return postResolveConflictRequest({
    type: 'RESOLVE_QUEUE_CONFLICT',
    key: input.key,
    itemId: input.itemId,
    localBranches: input.localBranches,
    serverBranches: input.serverBranches,
  })
}

export async function rescueStaleCompactedBranchInWorker(input: {
  key: CryptoKey
  itemId: string
  localBranch: VaultBranch
  serverBranch: VaultBranch
}): Promise<ResolvedBranch> {
  return postRescueStaleBranchRequest({
    type: 'RESCUE_STALE_COMPACTED_BRANCH',
    key: input.key,
    itemId: input.itemId,
    localBranch: input.localBranch,
    serverBranch: input.serverBranch,
  })
}
