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

export type PushSyncBatchInput = {
  account?: string
  messages: Array<{
    itemId: string
    encryptedMessage: SyncMessageEnvelope
  }>
}

export type PushSyncBatchResponse = {
  success: boolean
  results: Array<{
    itemId: string
    cursor: number
  }>
}

export type PullSyncBatchInput = {
  account?: string
  cursors: Array<{
    itemId: string
    cursor?: number
  }>
}

export type PullSyncBatchResponse = {
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

export async function pushSyncMessage(input: PushSyncMessageInput): Promise<{ success: boolean; cursor: number }> {
  const response = await pushSyncBatch({
    account: input.account,
    messages: [{
      itemId: input.itemId,
      encryptedMessage: input.encryptedMessage,
    }],
  })

  const result = response.results.find(entry => entry.itemId === input.itemId)
  if (!result) {
    throw new Error('Sync push failed: missing cursor in batch response')
  }

  return {
    success: response.success,
    cursor: result.cursor,
  }
}

export async function pushSyncBatch(input: PushSyncBatchInput): Promise<PushSyncBatchResponse> {
  const account = input.account || getAccountId()

  const response = await trackedFetch(`${requireEndpoint()}/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      account,
      messages: input.messages,
    }),
  })

  if (!response.ok) {
    throw new Error(`Sync push failed with status ${response.status}`)
  }

  return response.json() as Promise<PushSyncBatchResponse>
}

export async function pullSyncMessages(input: PullSyncMessagesInput): Promise<PullSyncMessagesResponse> {
  const response = await pullSyncBatch({
    account: input.account,
    cursors: [{
      itemId: input.itemId,
      cursor: input.cursor,
    }],
  })

  const result = response.results.find(entry => entry.itemId === input.itemId)
  if (result) {
    return result
  }

  return {
    success: true,
    itemId: input.itemId,
    nextCursor: typeof input.cursor === 'number' ? input.cursor : 0,
    messages: [],
  }
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

  if (!response.ok) {
    throw new Error(`Sync pull failed with status ${response.status}`)
  }

  return response.json() as Promise<PullSyncBatchResponse>
}
