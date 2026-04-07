import env from '../../env'
import { trackedFetch } from '../runtime'
import { getAccountId } from '../util'
import type { CryptoResult } from './crypto'

export type SyncMessageEnvelope = CryptoResult

type PushSyncMessageInput = {
  account?: string
  itemId: string
  encryptedMessage: SyncMessageEnvelope
}

type PullSyncMessagesInput = {
  account?: string
  itemId: string
  cursor?: number
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

export async function pushSyncMessage(input: PushSyncMessageInput): Promise<{ success: boolean; cursor: number }> {
  const account = input.account || getAccountId()

  const response = await trackedFetch(`${requireEndpoint()}/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      account,
      itemId: input.itemId,
      encryptedMessage: input.encryptedMessage,
    }),
  })

  if (!response.ok) {
    throw new Error(`Sync push failed with status ${response.status}`)
  }

  return response.json() as Promise<{ success: boolean; cursor: number }>
}

export async function pullSyncMessages(input: PullSyncMessagesInput): Promise<PullSyncMessagesResponse> {
  const account = input.account || getAccountId()
  const url = new URL(`${requireEndpoint()}/sync/pull`)
  url.searchParams.set('account', account)
  url.searchParams.set('itemId', input.itemId)
  if (typeof input.cursor === 'number' && input.cursor > 0) {
    url.searchParams.set('cursor', String(input.cursor))
  }

  const response = await trackedFetch(url, {
    method: 'GET',
  })

  if (!response.ok) {
    throw new Error(`Sync pull failed with status ${response.status}`)
  }

  return response.json() as Promise<PullSyncMessagesResponse>
}
