import { createTRPCProxyClient } from '@trpc/client'
import type { inferRouterOutputs } from '@trpc/server'
import type { VaultRouter } from '@vault/server'
import { createVaultLinks } from './vaultTrpcClient'
import type { VaultSnapshotInput, SyncPollBatchSchema } from '@vault/shared'
import type { z } from 'zod'

type VaultOutputs = inferRouterOutputs<VaultRouter>

let untrackedClient: ReturnType<typeof createTRPCProxyClient<VaultRouter>> | null = null

/**
 * The client for the sync worker's background requests (polls and snapshot uploads). It skips the
 * tracked fetch, so these requests don't show as activity in the sync status. Like the other
 * clients, it sends the realm's current session token.
 */
function getUntrackedClient() {
  untrackedClient ??= createTRPCProxyClient<VaultRouter>({
    links: createVaultLinks(),
  })
  return untrackedClient
}

export type PollSyncBatchResponse = VaultOutputs['sync']['pollSync']
export type PullSyncMessagesResponse = PollSyncBatchResponse['pullResults'][number]
export type PushResultItem = PollSyncBatchResponse['pushResults'][number]
export type PutSnapshotsResponse = VaultOutputs['items']['putSnapshots']

export async function pollSyncBatch(
  input: z.infer<typeof SyncPollBatchSchema>,
  options?: { signal?: AbortSignal }
): Promise<PollSyncBatchResponse> {
  return getUntrackedClient().sync.pollSync.mutate(input, options)
}

export async function putSnapshots(
  input: {
    account: string
    snapshots: VaultSnapshotInput[]
  },
  options?: { signal?: AbortSignal }
): Promise<PutSnapshotsResponse> {
  return getUntrackedClient().items.putSnapshots.mutate(
    {
      account: input.account,
      snapshots: input.snapshots,
    },
    options
  )
}
