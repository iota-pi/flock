import { normalizeSyncError } from '../shared/syncErrors'
import { trpcClient } from '../api/trpcClient'
import { registerMutationStrategy } from './mutationStrategyRegistry'

const CHUNK_SIZE = 50

let registered = false

function withNormalizedErrors<T>(
  execute: (payload: T, mutationId: string) => Promise<void>,
) {
  return async (payload: T, mutationId: string): Promise<void> => {
    try {
      await execute(payload, mutationId)
    } catch (error) {
      throw normalizeSyncError(error)
    }
  }
}

export function ensureDefaultMutationStrategiesRegistered(): void {
  if (registered) {
    return
  }

  const executePut = withNormalizedErrors(async (payload: Parameters<typeof trpcClient.items.put.mutate>[0], mutationId) => {
    await trpcClient.items.put.mutate({
      ...payload,
      idempotencyKey: mutationId,
    })
  })

  const executePutMany = withNormalizedErrors(async (payload: Parameters<typeof trpcClient.items.putMany.mutate>[0], mutationId) => {
    const payloadItems = payload.items || []

    if (payloadItems.length <= CHUNK_SIZE) {
      await trpcClient.items.putMany.mutate({
        ...payload,
        idempotencyKey: mutationId,
      })
      return
    }

    for (let index = 0; index < payloadItems.length; index += CHUNK_SIZE) {
      const chunk = payloadItems.slice(index, index + CHUNK_SIZE)
      await trpcClient.items.putMany.mutate({
        ...payload,
        items: chunk,
        idempotencyKey: mutationId,
      })
    }
  })

  const executeResolveConflict = withNormalizedErrors(async (payload: Parameters<typeof trpcClient.items.resolveBranchConflict.mutate>[0], mutationId) => {
    await trpcClient.items.resolveBranchConflict.mutate({
      ...payload,
      idempotencyKey: mutationId,
    })
  })

  const executeUpdateMetadata = withNormalizedErrors(async (payload: Parameters<typeof trpcClient.accounts.updateMetadata.mutate>[0]) => {
    await trpcClient.accounts.updateMetadata.mutate(payload)
  })

  registerMutationStrategy('items.put', {
    execute: mutation => executePut(
      mutation.payload as Parameters<typeof trpcClient.items.put.mutate>[0],
      mutation.id,
    ),
  })

  registerMutationStrategy('items.putMany', {
    execute: mutation => executePutMany(
      mutation.payload as Parameters<typeof trpcClient.items.putMany.mutate>[0],
      mutation.id,
    ),
  })

  registerMutationStrategy('items.resolveBranchConflict', {
    execute: mutation => executeResolveConflict(
      mutation.payload as Parameters<typeof trpcClient.items.resolveBranchConflict.mutate>[0],
      mutation.id,
    ),
  })

  registerMutationStrategy('accounts.updateMetadata', {
    execute: mutation => executeUpdateMetadata(
      mutation.payload as Parameters<typeof trpcClient.accounts.updateMetadata.mutate>[0],
      mutation.id,
    ),
  })

  registered = true
}