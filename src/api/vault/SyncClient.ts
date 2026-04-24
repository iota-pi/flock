import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import { assertSuccess } from './clientUtils'

type SyncMessageEnvelope = {
  iv: string
  cipher: string
}

type PullSyncBatchInput = {
  account?: string
  cursors: Array<{
    itemId: string
    cursor?: number
  }>
}

type PushSyncBatchInput = {
  account?: string
  messages: Array<{
    itemId: string
    encryptedMessage: SyncMessageEnvelope
  }>
}

export type PullSyncMessagesResponse = {
  success: boolean
  itemId: string
  nextCursor: number
  messages: Array<{
    cursor: number
    encryptedMessage: SyncMessageEnvelope
  }>
}

export type PullSyncBatchResponse = {
  success: boolean
  results: PullSyncMessagesResponse[]
}

export async function pullSyncBatch(input: PullSyncBatchInput): Promise<PullSyncBatchResponse> {
  const response = await trpcClient.sync.pullBatch.query({
    account: input.account || getAccountId(),
    cursors: input.cursors,
  })

  assertSuccess(response, 'pullSyncBatch')
  return response as PullSyncBatchResponse
}

export async function pushSyncBatch(input: PushSyncBatchInput): Promise<{ success: true; results: Array<{ itemId: string; cursor: number }> }> {
  const response = await trpcClient.sync.pushBatch.mutate({
    account: input.account || getAccountId(),
    messages: input.messages,
  })

  assertSuccess(response, 'pushSyncBatch')
  return response
}
