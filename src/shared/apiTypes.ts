// Shared API wire types between frontend (app) and backend (vault)
// Keep these minimal and focused on request/response payloads.

export const ITEM_TYPES = ['person', 'group'] as const
export type ItemType = typeof ITEM_TYPES[number]

export interface VaultItemMetadata {
  type: ItemType
  iv: string
  modified: number
}

export interface VaultKey {
  item: string
}

export interface VaultItem extends VaultKey {
  cipher: string
  metadata: VaultItemMetadata
}

// Frontend-defined push subscription configuration (custom, not Web Push endpoint)
export interface FlockPushSubscription {
  failures: number
  hours: number[]
  timezone: string
  token: string
}

export interface VaultSubscription {
  subscription: FlockPushSubscription
}

// Requests
export interface PutItemRequestBody extends VaultItemMetadata {
  cipher: string
}
export interface PutItemsBatchEntry extends VaultItemMetadata {
  id: string
  cipher: string
}
export type PutItemsBatchRequestBody = PutItemsBatchEntry[]
export type DeleteItemsBatchRequestBody = string[]

// Generic response helpers
export interface SuccessResponse { success: boolean }

export interface ItemsResponse { items: VaultItem[] }
export interface AccountCreationResponse { account: string }
export interface SaltResponse extends SuccessResponse { salt?: string }
export interface SessionResponse extends SuccessResponse { session?: string }
export interface MetadataResponse { metadata?: unknown }
export interface SubscriptionGetResponse extends SuccessResponse { subscription?: FlockPushSubscription | null }

// Error envelope (if server chooses to send structured errors)
export interface ErrorResponse {
  error: string
  code?: string
}

export type PutItemResponse = SuccessResponse
export type PutItemsBatchResponse = SuccessResponse
export type DeleteItemResponse = SuccessResponse
export type DeleteItemsBatchResponse = SuccessResponse
export type SetMetadataResponse = SuccessResponse
export type SetSubscriptionResponse = SuccessResponse
export type DeleteSubscriptionResponse = SuccessResponse
