import type { VaultBranch } from '../shared/itemTypes'
import type { VaultItem } from '../api/vault/client'
import { type Remote, wrap } from 'comlink'

type ResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

type ResolveConflictRequest = {
  key: CryptoKey
  itemId: string
  localBranches: ResolvedBranch[]
  serverBranches: ResolvedBranch[]
}

type RescueStaleBranchRequest = {
  key: CryptoKey
  itemId: string
  localBranch: ResolvedBranch
  serverBranch: ResolvedBranch
}

type DecryptionConflictWorkerApi = {
  resolveQueueConflict: (request: ResolveConflictRequest) => Promise<ResolvedBranch>
  rescueStaleCompactedBranch: (request: RescueStaleBranchRequest) => Promise<ResolvedBranch>
}

export type WorkerDecryptedItem = {
  id: string
  automergeBinary?: Uint8Array
  [key: string]: unknown
}

type DecryptionWorkerResponse =
  | {
    type: 'DECRYPTION_RESULT'
    jobId?: number
    items?: Array<Record<string, unknown>>
  }
  | {
    type: 'CORRUPTED_ITEM_DETECTED'
    itemId?: unknown
    failedBranches?: unknown
  }
  | {
    type: 'CONFLICT_RESOLVED'
    itemId?: unknown
    resolvedBranch?: ResolvedBranch
  }
  | {
    type: 'HISTORY_EVALUATED'
    jobId?: number
    healthyEnvelope?: VaultItem | null
  }
  | {
    type: 'COMPACTED_ENVELOPE'
    jobId?: number
    itemId?: unknown
    baseVersionId?: unknown
    compactedBranch?: ResolvedBranch
    compactedBinary?: unknown
  }

type PendingPromise<T> = {
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
}

type DecryptionWorkerCallbacks = {
  onCorruptedItem?: (event: { itemId: string; failedBranches?: string[] }) => void
  onConflictResolved?: (event: { itemId: string; resolvedBranch: ResolvedBranch }) => void
}

const COMPACTION_THRESHOLD_BYTES = 100_000
const COMPACTION_COOLDOWN_MS = 15 * 60 * 1000
const FAILED_COMPACTION_COOLDOWN_MS = 60 * 1000

let worker: Worker | null = null
let workerApi: Remote<DecryptionConflictWorkerApi> | null = null
let pendingTaskChain: Promise<void> = Promise.resolve()

let decryptionWorker: Worker | null = null
let nextDecryptionJobId = 0
const pendingDecryptionJobs = new Map<number, PendingPromise<WorkerDecryptedItem[]>>()
const pendingHistoryJobs = new Map<number, PendingPromise<VaultItem | null>>()
const pendingCompactionJobs = new Map<number, PendingPromise<{
  itemId: string
  baseVersionId: string
  compactedBranch: ResolvedBranch
  compactedBinary: Uint8Array
}>>()
const decryptionWorkerCallbacks: DecryptionWorkerCallbacks = {}
const compactionInFlightItemIds = new Set<string>()
const compactionCooldownUntilByItemId = new Map<string, number>()

function enqueueWorkerTask<T>(task: () => Promise<T>): Promise<T> {
  const nextTask = pendingTaskChain.then(task, task)
  pendingTaskChain = nextTask.then(
    () => undefined,
    () => undefined,
  )
  return nextTask
}

function getWorkerApi(): Remote<DecryptionConflictWorkerApi> {
  if (workerApi) {
    return workerApi
  }

  worker = new Worker(new URL('./decryptionConflict.worker.ts', import.meta.url), {
    type: 'module',
  })
  workerApi = wrap<DecryptionConflictWorkerApi>(worker)

  worker.onerror = () => {
    worker = null
    workerApi = null
  }

  return workerApi
}

function rejectAllPendingJobs(error: Error): void {
  for (const pending of pendingDecryptionJobs.values()) {
    pending.reject(error)
  }
  for (const pending of pendingHistoryJobs.values()) {
    pending.reject(error)
  }
  for (const pending of pendingCompactionJobs.values()) {
    pending.reject(error)
  }

  pendingDecryptionJobs.clear()
  pendingHistoryJobs.clear()
  pendingCompactionJobs.clear()
}

function getCompactionCooldownUntil(itemId: string): number {
  return compactionCooldownUntilByItemId.get(itemId) || 0
}

function getDecryptionWorker(): Worker {
  if (decryptionWorker) {
    return decryptionWorker
  }

  decryptionWorker = new Worker(new URL('./decryption.worker.ts', import.meta.url), {
    type: 'module',
  })

  decryptionWorker.onmessage = event => {
    const payload = event.data as DecryptionWorkerResponse

    if (payload.type === 'CORRUPTED_ITEM_DETECTED') {
      if (typeof payload.itemId === 'string') {
        const failedBranches = Array.isArray(payload.failedBranches)
          ? payload.failedBranches.filter((value): value is string => typeof value === 'string')
          : undefined
        decryptionWorkerCallbacks.onCorruptedItem?.({
          itemId: payload.itemId,
          failedBranches,
        })
      }
      return
    }

    if (payload.type === 'CONFLICT_RESOLVED') {
      if (typeof payload.itemId === 'string' && payload.resolvedBranch) {
        decryptionWorkerCallbacks.onConflictResolved?.({
          itemId: payload.itemId,
          resolvedBranch: payload.resolvedBranch,
        })
      }
      return
    }

    if (payload.type === 'HISTORY_EVALUATED') {
      const jobId = typeof payload.jobId === 'number' ? payload.jobId : -1
      const pending = pendingHistoryJobs.get(jobId)
      if (!pending) {
        return
      }

      pendingHistoryJobs.delete(jobId)
      pending.resolve(payload.healthyEnvelope || null)
      return
    }

    if (payload.type === 'COMPACTED_ENVELOPE') {
      const jobId = typeof payload.jobId === 'number' ? payload.jobId : -1
      const pending = pendingCompactionJobs.get(jobId)
      if (!pending) {
        return
      }

      pendingCompactionJobs.delete(jobId)
      if (
        typeof payload.itemId !== 'string'
        || typeof payload.baseVersionId !== 'string'
        || !payload.compactedBranch
        || !(payload.compactedBinary instanceof Uint8Array)
      ) {
        pending.reject(new Error('Invalid COMPACTED_ENVELOPE payload from worker'))
        return
      }

      pending.resolve({
        itemId: payload.itemId,
        baseVersionId: payload.baseVersionId,
        compactedBranch: payload.compactedBranch,
        compactedBinary: payload.compactedBinary,
      })
      return
    }

    const jobId = typeof payload.jobId === 'number' ? payload.jobId : -1
    const pending = pendingDecryptionJobs.get(jobId)
    if (!pending) {
      return
    }

    const normalized = (payload.items || []).flatMap((item): WorkerDecryptedItem[] => {
      if (!item || typeof item !== 'object') {
        return []
      }

      const id = (item as { id?: unknown }).id
      if (typeof id !== 'string') {
        return []
      }

      const automergeBinary = (item as { automergeBinary?: unknown }).automergeBinary
      return [{
        ...item,
        id,
        automergeBinary: automergeBinary instanceof Uint8Array ? automergeBinary : undefined,
      }]
    })

    pendingDecryptionJobs.delete(jobId)
    pending.resolve(normalized)
  }

  decryptionWorker.onerror = event => {
    const error = new Error(event.message || 'Worker decryption failed')
    rejectAllPendingJobs(error)
    decryptionWorker = null
  }

  return decryptionWorker
}

function nextJobId(): number {
  nextDecryptionJobId += 1
  return nextDecryptionJobId
}

export function configureDecryptionWorkerCallbacks(callbacks: DecryptionWorkerCallbacks): void {
  decryptionWorkerCallbacks.onCorruptedItem = callbacks.onCorruptedItem
  decryptionWorkerCallbacks.onConflictResolved = callbacks.onConflictResolved
}

export async function decryptItemsInWorker(input: {
  key: CryptoKey
  items: VaultItem[]
}): Promise<WorkerDecryptedItem[]> {
  const activeWorker = getDecryptionWorker()
  const jobId = nextJobId()

  return new Promise((resolve, reject) => {
    pendingDecryptionJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      type: 'DECRYPT_ITEMS',
      jobId,
      key: input.key,
      items: input.items,
    })
  })
}

export async function evaluateHistoryInWorker(input: {
  key: CryptoKey
  itemId: string
  history: VaultItem[]
}): Promise<VaultItem | null> {
  const activeWorker = getDecryptionWorker()
  const jobId = nextJobId()

  return new Promise((resolve, reject) => {
    pendingHistoryJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      type: 'EVALUATE_HISTORY',
      jobId,
      key: input.key,
      itemId: input.itemId,
      history: input.history,
    })
  })
}

export async function compactItemInWorker(input: {
  key: CryptoKey
  itemId: string
  baseVersionId: string
  automergeBinary: Uint8Array
}): Promise<{
  itemId: string
  baseVersionId: string
  compactedBranch: ResolvedBranch
  compactedBinary: Uint8Array
}> {
  const activeWorker = getDecryptionWorker()
  const jobId = nextJobId()
  const binaryToTransfer = input.automergeBinary.slice()

  return new Promise((resolve, reject) => {
    pendingCompactionJobs.set(jobId, { resolve, reject })
    activeWorker.postMessage({
      type: 'COMPACT_ITEM',
      jobId,
      key: input.key,
      itemId: input.itemId,
      baseVersionId: input.baseVersionId,
      automergeBinary: binaryToTransfer,
    }, [binaryToTransfer.buffer])
  })
}

export async function maybeCompactItemInWorker(input: {
  key: CryptoKey
  source: VaultItem
  automergeBinary: Uint8Array
  onCompacted: (compacted: {
    itemId: string
    baseVersionId: string
    compactedBranch: ResolvedBranch
    compactedBinary: Uint8Array
  }) => Promise<void>
  onError?: (error: unknown) => void
}): Promise<void> {
  if (input.automergeBinary.byteLength <= COMPACTION_THRESHOLD_BYTES) {
    return
  }

  if (input.source.metadata?.deleted === true || !Array.isArray(input.source.branches) || input.source.branches.length === 0) {
    return
  }

  const itemId = input.source.item
  const baseVersionId = input.source.branches[0]?.versionId
  if (!itemId || !baseVersionId) {
    return
  }

  const now = Date.now()
  if (compactionInFlightItemIds.has(itemId) || getCompactionCooldownUntil(itemId) > now) {
    return
  }

  if (typeof input.source.metadata?.compactedAt === 'number' && now - input.source.metadata.compactedAt < COMPACTION_COOLDOWN_MS) {
    return
  }

  compactionInFlightItemIds.add(itemId)
  try {
    const compacted = await compactItemInWorker({
      key: input.key,
      itemId,
      baseVersionId,
      automergeBinary: input.automergeBinary,
    })
    await input.onCompacted(compacted)
    compactionCooldownUntilByItemId.set(itemId, Date.now() + COMPACTION_COOLDOWN_MS)
  } catch (error) {
    compactionCooldownUntilByItemId.set(itemId, Date.now() + FAILED_COMPACTION_COOLDOWN_MS)
    input.onError?.(error)
  } finally {
    compactionInFlightItemIds.delete(itemId)
  }
}

export async function resolveQueueConflictInWorker(input: {
  key: CryptoKey
  itemId: string
  localBranches: VaultBranch[]
  serverBranches: VaultBranch[]
}): Promise<ResolvedBranch> {
  return enqueueWorkerTask(async () => {
    const api = getWorkerApi()
    return api.resolveQueueConflict({
      key: input.key,
      itemId: input.itemId,
      localBranches: input.localBranches,
      serverBranches: input.serverBranches,
    })
  })
}

export async function rescueStaleCompactedBranchInWorker(input: {
  key: CryptoKey
  itemId: string
  localBranch: VaultBranch
  serverBranch: VaultBranch
}): Promise<ResolvedBranch> {
  return enqueueWorkerTask(async () => {
    const api = getWorkerApi()
    return api.rescueStaleCompactedBranch({
      key: input.key,
      itemId: input.itemId,
      localBranch: input.localBranch,
      serverBranch: input.serverBranch,
    })
  })
}
