import { trpcClient } from '../api/trpcClient'
import type { QueueNetworkExecutor } from './queueNetworkExecutor'

export function createTrpcQueueNetworkExecutor(): QueueNetworkExecutor {
  return {
    put: async payload => {
      await trpcClient.items.put.mutate(
        payload as Parameters<typeof trpcClient.items.put.mutate>[0],
      )
    },
    putMany: async payload => {
      await trpcClient.items.putMany.mutate(
        payload as Parameters<typeof trpcClient.items.putMany.mutate>[0],
      )
    },
    resolveBranchConflict: async payload => {
      await trpcClient.items.resolveBranchConflict.mutate(
        payload as Parameters<typeof trpcClient.items.resolveBranchConflict.mutate>[0],
      )
    },
    updateMetadata: async payload => {
      await trpcClient.accounts.updateMetadata.mutate(
        payload as Parameters<typeof trpcClient.accounts.updateMetadata.mutate>[0],
      )
    },
  }
}
