import { normalizeSyncError } from '../shared/syncErrors'
import { registerMutationStrategy } from './mutationStrategyRegistry'
import type { QueueNetworkExecutor } from './queueNetworkExecutor'

const CHUNK_SIZE = 50

let registered = false
let registeredExecutor: QueueNetworkExecutor | null = null

function withNormalizedErrors<T>(
  execute: (payload: T, mutationId: string, executor: QueueNetworkExecutor) => Promise<void>,
) {
  return async (payload: T, mutationId: string, executor: QueueNetworkExecutor): Promise<void> => {
    try {
      await execute(payload, mutationId, executor)
    } catch (error) {
      throw normalizeSyncError(error)
    }
  }
}

export function ensureDefaultMutationStrategiesRegistered(executor: QueueNetworkExecutor): void {
  if (registered && registeredExecutor === executor) {
    return
  }

  const executePut = withNormalizedErrors(async (payload: unknown, mutationId, currentExecutor) => {
    const putPayload = payload as Record<string, unknown>
    await currentExecutor.put({
      ...putPayload,
      idempotencyKey: mutationId,
    })
  })

  const executePutMany = withNormalizedErrors(async (payload: unknown, mutationId, currentExecutor) => {
    const putManyPayload = payload as { items?: unknown[] }
    const payloadItems = putManyPayload.items || []

    if (payloadItems.length <= CHUNK_SIZE) {
      const basePayload = payload as Record<string, unknown>
      await currentExecutor.putMany({
        ...basePayload,
        idempotencyKey: mutationId,
      })
      return
    }

    for (let index = 0; index < payloadItems.length; index += CHUNK_SIZE) {
      const chunk = payloadItems.slice(index, index + CHUNK_SIZE)
      const basePayload = payload as Record<string, unknown>
      await currentExecutor.putMany({
        ...basePayload,
        items: chunk,
        idempotencyKey: mutationId,
      })
    }
  })

  const executeResolveConflict = withNormalizedErrors(async (payload: unknown, mutationId, currentExecutor) => {
    const resolvePayload = payload as Record<string, unknown>
    await currentExecutor.resolveBranchConflict({
      ...resolvePayload,
      idempotencyKey: mutationId,
    })
  })

  const executeUpdateMetadata = withNormalizedErrors(async (payload: unknown, _mutationId, currentExecutor) => {
    await currentExecutor.updateMetadata(payload)
  })

  registerMutationStrategy('items.put', {
    execute: mutation => executePut(mutation.payload, mutation.id, executor),
  })

  registerMutationStrategy('items.putMany', {
    execute: mutation => executePutMany(mutation.payload, mutation.id, executor),
  })

  registerMutationStrategy('items.resolveBranchConflict', {
    execute: mutation => executeResolveConflict(mutation.payload, mutation.id, executor),
  })

  registerMutationStrategy('accounts.updateMetadata', {
    execute: mutation => executeUpdateMetadata(mutation.payload, mutation.id, executor),
  })

  registered = true
  registeredExecutor = executor
}