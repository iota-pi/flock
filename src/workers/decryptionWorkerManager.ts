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

type DecryptionWorkerApi = {
  decryptItems: (input: {
    key: CryptoKey
    items: VaultItem[]
  }) => Promise<{
    items: Array<Record<string, unknown>>
    corrupted: Array<{ itemId: string; failedBranches?: string[] }>
    resolvedConflicts: Array<{ itemId: string; resolvedBranch: ResolvedBranch }>
  }>
  evaluateHistory: (input: {
    key: CryptoKey
    itemId: string
    history: VaultItem[]
  }) => Promise<VaultItem | null>
  compactItem: (input: {
    key: CryptoKey
    itemId: string
    baseVersionId: string
    automergeBinary: Uint8Array
  }) => Promise<{
    itemId: string
    baseVersionId: string
    compactedBranch: ResolvedBranch
    compactedBinary: Uint8Array
  }>
  mergeObjects: (input: {
    left: Record<string, unknown>
    right: Record<string, unknown>
  }) => Promise<Record<string, unknown>>
}

export type WorkerDecryptedItem = {
  id: string
  automergeBinary?: Uint8Array
  [key: string]: unknown
}

type DecryptionWorkerCallbacks = {
  onCorruptedItem?: (event: { itemId: string; failedBranches?: string[] }) => void
  onConflictResolved?: (event: { itemId: string; resolvedBranch: ResolvedBranch }) => void
}

const COMPACTION_THRESHOLD_BYTES = 100_000
const COMPACTION_COOLDOWN_MS = 15 * 60 * 1000
const FAILED_COMPACTION_COOLDOWN_MS = 60 * 1000

let conflictWorker: Worker | null = null
let conflictWorkerApi: Remote<DecryptionConflictWorkerApi> | null = null
let pendingTaskChain: Promise<void> = Promise.resolve()

let decryptionWorker: Worker | null = null
let decryptionWorkerApi: Remote<DecryptionWorkerApi> | null = null
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

function getConflictWorkerApi(): Remote<DecryptionConflictWorkerApi> {
  if (conflictWorkerApi) {
    return conflictWorkerApi
  }

  conflictWorker = new Worker(new URL('./decryptionConflict.worker.ts', import.meta.url), {
    type: 'module',
  })
  conflictWorkerApi = wrap<DecryptionConflictWorkerApi>(conflictWorker)

  conflictWorker.onerror = () => {
    conflictWorker = null
    conflictWorkerApi = null
  }

  return conflictWorkerApi
}

function getCompactionCooldownUntil(itemId: string): number {
  return compactionCooldownUntilByItemId.get(itemId) || 0
}

function getDecryptionWorkerApi(): Remote<DecryptionWorkerApi> {
  if (decryptionWorkerApi) {
    return decryptionWorkerApi
  }

  decryptionWorker = new Worker(new URL('./decryption.worker.ts', import.meta.url), {
    type: 'module',
  })
  decryptionWorkerApi = wrap<DecryptionWorkerApi>(decryptionWorker)

  decryptionWorker.onerror = event => {
    const error = new Error(event.message || 'Worker decryption failed')
    console.error(error)
    decryptionWorker = null
    decryptionWorkerApi = null
  }

  return decryptionWorkerApi
}

export function configureDecryptionWorkerCallbacks(callbacks: DecryptionWorkerCallbacks): void {
  decryptionWorkerCallbacks.onCorruptedItem = callbacks.onCorruptedItem
  decryptionWorkerCallbacks.onConflictResolved = callbacks.onConflictResolved
}

export async function decryptItemsInWorker(input: {
  key: CryptoKey
  items: VaultItem[]
}): Promise<WorkerDecryptedItem[]> {
  const api = getDecryptionWorkerApi()
  const result = await api.decryptItems({
    key: input.key,
    items: input.items,
  })

  for (const corrupted of result.corrupted) {
    decryptionWorkerCallbacks.onCorruptedItem?.({
      itemId: corrupted.itemId,
      failedBranches: corrupted.failedBranches,
    })
  }

  for (const conflict of result.resolvedConflicts) {
    decryptionWorkerCallbacks.onConflictResolved?.({
      itemId: conflict.itemId,
      resolvedBranch: conflict.resolvedBranch,
    })
  }

  return result.items.flatMap((item): WorkerDecryptedItem[] => {
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
}

export async function evaluateHistoryInWorker(input: {
  key: CryptoKey
  itemId: string
  history: VaultItem[]
}): Promise<VaultItem | null> {
  const api = getDecryptionWorkerApi()
  return api.evaluateHistory({
    key: input.key,
    itemId: input.itemId,
    history: input.history,
  })
}

export async function mergeObjectsInWorker<T extends Record<string, unknown>>(input: {
  left: T
  right: T
}): Promise<T> {
  const api = getDecryptionWorkerApi()
  const merged = await api.mergeObjects({
    left: input.left,
    right: input.right,
  })

  return merged as T
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
  const api = getDecryptionWorkerApi()
  const binaryToTransfer = input.automergeBinary.slice()

  return api.compactItem({
    key: input.key,
    itemId: input.itemId,
    baseVersionId: input.baseVersionId,
    automergeBinary: binaryToTransfer,
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
    const api = getConflictWorkerApi()
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
    const api = getConflictWorkerApi()
    return api.rescueStaleCompactedBranch({
      key: input.key,
      itemId: input.itemId,
      localBranch: input.localBranch,
      serverBranch: input.serverBranch,
    })
  })
}
