import env from '../../env'
import { trackedFetch } from '../runtime'
import { getAccountId } from '../util'
import type { CryptoResult } from './crypto'

type SyncMessageEnvelope = CryptoResult

type PullSyncBatchInput = {
  account?: string
  cursors: Array<{
    itemId: string
    cursor?: number
  }>
}

type PullSyncBatchResponse = {
  success: boolean
  results: PullSyncMessagesResponse[]
}

type PullSyncMessagesResponse = {
  success: boolean
  itemId: string
  nextCursor: number
  messages: Array<{
    cursor: number
    encryptedMessage: SyncMessageEnvelope
  }>
}

function requireEndpoint(): string {
  if (!env.VAULT_ENDPOINT) {
    throw new Error('Vault endpoint is not configured')
  }

  return env.VAULT_ENDPOINT
}

export async function pullSyncBatch(input: PullSyncBatchInput): Promise<PullSyncBatchResponse> {
  const account = input.account || getAccountId()
  const response = await trackedFetch(`${requireEndpoint()}/sync/pull`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      account,
      cursors: input.cursors,
    }),
  })

  return response.json() as Promise<PullSyncBatchResponse>
}
