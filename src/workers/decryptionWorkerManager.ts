import type { VaultBranch } from '../shared/itemTypes'
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

let worker: Worker | null = null
let workerApi: Remote<DecryptionConflictWorkerApi> | null = null

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

export async function resolveQueueConflictInWorker(input: {
  key: CryptoKey
  itemId: string
  localBranches: VaultBranch[]
  serverBranches: VaultBranch[]
}): Promise<ResolvedBranch> {
  const api = getWorkerApi()
  return api.resolveQueueConflict({
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
  const api = getWorkerApi()
  return api.rescueStaleCompactedBranch({
    key: input.key,
    itemId: input.itemId,
    localBranch: input.localBranch,
    serverBranch: input.serverBranch,
  })
}
