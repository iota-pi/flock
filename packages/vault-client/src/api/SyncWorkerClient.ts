import { createTRPCProxyClient } from '@trpc/client'
import type { VaultRouter } from '@vault/server'
import { createVaultLinks } from './vaultTrpcClient'
import type { VaultSnapshotInput, ItemId , DOC_BOUND_FORMAT ,
  SyncPollBatchSchema,
  PageToken,
  PutSnapshotResultItem } from '@vault/shared'
import type { z } from 'zod'
type SyncMessageEnvelope = {
  iv: string
  cipher: string
  version?: string
  kver?: string
  format?: typeof DOC_BOUND_FORMAT
}

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

export type PullSyncMessagesResponse = {
  success?: boolean
  itemId: ItemId
  cursor?: number
  nextCursor?: number
  messages: Array<{
    cursor: number
    encryptedMessage: SyncMessageEnvelope
  }>
  hasMore: boolean
  nextPageToken?: PageToken
}

export type PushResultItem = {
  itemId: ItemId
  cursor?: number
  success?: boolean
  error?: string
}

export type PollSyncBatchResponse = {
  success: boolean
  pushResults: Array<PushResultItem>
  pullResults: Array<PullSyncMessagesResponse>
  hasMore?: boolean
  globalNextPageToken?: PageToken
  // Whether the account-wide scan has more pages
  globalHasMore?: boolean
  // Highest cursor examined by the account-wide scan
  globalScannedThroughCursor?: number
}


export async function pollSyncBatch(
  input: z.infer<typeof SyncPollBatchSchema>,
  options?: { signal?: AbortSignal }
): Promise<PollSyncBatchResponse> {
  return getUntrackedClient().sync.pollSync.mutate(input, options?.signal ? { signal: options.signal } : undefined)
}

export async function putSnapshots(
  input: {
    account: string
    snapshots: VaultSnapshotInput[]
  },
  options?: { signal?: AbortSignal }
): Promise<{ success: boolean; persisted: number; total: number; results?: PutSnapshotResultItem[] }> {
  return getUntrackedClient().items.putSnapshots.mutate(
    {
      account: input.account,
      snapshots: input.snapshots,
    },
    options?.signal ? { signal: options.signal } : undefined
  )
}

