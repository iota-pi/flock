// Shared API wire types between frontend (app) and backend (vault)
// Uses TypeBox for runtime validation schemas with derived TypeScript types

import { Type, Static } from 'typebox'

// =============================================================================
// Core Types
// =============================================================================

export const ItemTypeSchema = Type.Union([
  Type.Literal('person'),
  Type.Literal('group'),
])
export type ItemType = Static<typeof ItemTypeSchema>
export const ITEM_TYPES = ['person', 'group'] as const

// =============================================================================
// Vault Item Schemas
// =============================================================================

export const VaultItemMetadataSchema = Type.Object({
  type: ItemTypeSchema,
  iv: Type.String(),
  modified: Type.Number(),
  version: Type.Optional(Type.Number()),
})
export type VaultItemMetadata = Static<typeof VaultItemMetadataSchema>

export const VaultKeySchema = Type.Object({
  item: Type.String(),
})
export type VaultKey = Static<typeof VaultKeySchema>

export const VaultItemSchema = Type.Object({
  item: Type.String(),
  cipher: Type.String(),
  metadata: VaultItemMetadataSchema,
})
export type VaultItem = Static<typeof VaultItemSchema>

// CachedVaultItem allows partial data (used in responses)
export const CachedVaultItemSchema = Type.Object({
  item: Type.String(),
  cipher: Type.Optional(Type.String()),
  metadata: Type.Optional(VaultItemMetadataSchema),
})
export type CachedVaultItem = Static<typeof CachedVaultItemSchema>

// =============================================================================
// Subscription Schemas
// =============================================================================

export const FlockPushSubscriptionSchema = Type.Object({
  failures: Type.Number(),
  hours: Type.Array(Type.Number()),
  timezone: Type.String(),
  token: Type.String(),
})
export type FlockPushSubscription = Static<typeof FlockPushSubscriptionSchema>

export const VaultSubscriptionSchema = Type.Object({
  subscription: FlockPushSubscriptionSchema,
})
export type VaultSubscription = Static<typeof VaultSubscriptionSchema>

// =============================================================================
// Request Params Schemas
// =============================================================================

export const AccountParamsSchema = Type.Object(
  { account: Type.String() },
  { $id: 'vault.accountParams' },
)
export type AccountParams = Static<typeof AccountParamsSchema>

export const ItemParamsSchema = Type.Object(
  { account: Type.String(), item: Type.String() },
  { $id: 'vault.itemParams' },
)
export type ItemParams = Static<typeof ItemParamsSchema>

export const SubscriptionParamsSchema = Type.Object(
  { account: Type.String(), subscription: Type.String() },
  { $id: 'vault.subscriptionParams' },
)
export type SubscriptionParams = Static<typeof SubscriptionParamsSchema>

// =============================================================================
// Request Query Schemas
// =============================================================================

export const ItemsQuerySchema = Type.Object(
  {
    since: Type.Optional(Type.Number()),
    ids: Type.Optional(Type.String()),
  },
  { $id: 'vault.itemsQuery' },
)
export type ItemsQuery = Static<typeof ItemsQuerySchema>

// =============================================================================
// Request Body Schemas
// =============================================================================

export const CreateAccountBodySchema = Type.Object(
  {
    salt: Type.String({ minLength: 1 }),
    authToken: Type.String({ minLength: 1 }),
  },
  { $id: 'vault.createAccountBody' },
)
export type CreateAccountBody = Static<typeof CreateAccountBodySchema>

export const LoginBodySchema = Type.Object(
  { authToken: Type.String() },
  { $id: 'vault.loginBody' },
)
export type LoginBody = Static<typeof LoginBodySchema>

export const UpdateMetadataBodySchema = Type.Object(
  { metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())) },
  { $id: 'vault.updateMetadataBody' },
)
export type UpdateMetadataBody = Static<typeof UpdateMetadataBodySchema>

export const PutItemBodySchema = Type.Object(
  {
    cipher: Type.String(),
    iv: Type.String(),
    modified: Type.Number(),
    type: Type.String(),
    version: Type.Optional(Type.Number()),
  },
  { $id: 'vault.itemBody' },
)
export type PutItemBody = Static<typeof PutItemBodySchema>

export const PutItemsBatchEntrySchema = Type.Object({
  id: Type.String(),
  cipher: Type.String(),
  iv: Type.String(),
  modified: Type.Number(),
  type: Type.String(),
  version: Type.Optional(Type.Number()),
})
export type PutItemsBatchEntry = Static<typeof PutItemsBatchEntrySchema>

export const PutItemsBatchBodySchema = Type.Array(
  PutItemsBatchEntrySchema,
  { $id: 'vault.itemsBody' },
)
export type PutItemsBatchBody = Static<typeof PutItemsBatchBodySchema>

export const DeleteItemsBatchBodySchema = Type.Array(
  Type.String(),
  { $id: 'vault.deleteItemsBody' },
)
export type DeleteItemsBatchBody = Static<typeof DeleteItemsBatchBodySchema>

export const SubscriptionBodySchema = Type.Object(
  {
    failures: Type.Number(),
    hours: Type.Array(Type.Number()),
    timezone: Type.String(),
    token: Type.String(),
  },
  { $id: 'vault.subscriptionBody' },
)
export type SubscriptionBody = Static<typeof SubscriptionBodySchema>

// =============================================================================
// Response Schemas
// =============================================================================

export const SuccessResponseSchema = Type.Object(
  { success: Type.Boolean() },
  { $id: 'vault.successResponse' },
)
export type SuccessResponse = Static<typeof SuccessResponseSchema>

export const ErrorResponseSchema = Type.Object(
  {
    error: Type.String(),
    code: Type.Optional(Type.String()),
  },
  { $id: 'vault.errorResponse' },
)
export type ErrorResponse = Static<typeof ErrorResponseSchema>

export const AccountCreationResponseSchema = Type.Object(
  { account: Type.String() },
  { $id: 'vault.accountCreationResponse' },
)
export type AccountCreationResponse = Static<typeof AccountCreationResponseSchema>

export const SaltResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    salt: Type.Optional(Type.String()),
  },
  { $id: 'vault.saltResponse' },
)
export type SaltResponse = Static<typeof SaltResponseSchema>

export const SessionResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    session: Type.Optional(Type.String()),
  },
  { $id: 'vault.sessionResponse' },
)
export type SessionResponse = Static<typeof SessionResponseSchema>

export const MetadataResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    metadata: Type.Optional(Type.Unknown()),
  },
  { $id: 'vault.metadataResponse' },
)
export type MetadataResponse = Static<typeof MetadataResponseSchema>

export const ItemsResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    items: Type.Array(CachedVaultItemSchema),
  },
  { $id: 'vault.itemsResponse' },
)
export type ItemsResponse = Static<typeof ItemsResponseSchema>

export const BatchResultResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    details: Type.Array(Type.Object({
      item: Type.String(),
      success: Type.Boolean(),
      error: Type.Optional(Type.String()),
    })),
  },
  { $id: 'vault.batchResultResponse' },
)
export type BatchResultResponse = Static<typeof BatchResultResponseSchema>

export const SubscriptionGetResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    subscription: Type.Union([FlockPushSubscriptionSchema, Type.Null()]),
  },
  { $id: 'vault.subscriptionGetResponse' },
)
export type SubscriptionGetResponse = Static<typeof SubscriptionGetResponseSchema>

// =============================================================================
// Schema $id References (for Fastify schema registration)
// =============================================================================

export const SCHEMA_REFS = {
  // Params
  ACCOUNT_PARAMS: 'vault.accountParams#',
  ITEM_PARAMS: 'vault.itemParams#',
  SUBSCRIPTION_PARAMS: 'vault.subscriptionParams#',
  // Query
  ITEMS_QUERY: 'vault.itemsQuery#',
  // Bodies
  CREATE_ACCOUNT_BODY: 'vault.createAccountBody#',
  LOGIN_BODY: 'vault.loginBody#',
  UPDATE_METADATA_BODY: 'vault.updateMetadataBody#',
  ITEM_BODY: 'vault.itemBody#',
  ITEMS_BODY: 'vault.itemsBody#',
  DELETE_ITEMS_BODY: 'vault.deleteItemsBody#',
  SUBSCRIPTION_BODY: 'vault.subscriptionBody#',
  // Responses
  SUCCESS_RESPONSE: 'vault.successResponse#',
  ERROR_RESPONSE: 'vault.errorResponse#',
  ACCOUNT_CREATION_RESPONSE: 'vault.accountCreationResponse#',
  SALT_RESPONSE: 'vault.saltResponse#',
  SESSION_RESPONSE: 'vault.sessionResponse#',
  METADATA_RESPONSE: 'vault.metadataResponse#',
  ITEMS_RESPONSE: 'vault.itemsResponse#',
  BATCH_RESULT_RESPONSE: 'vault.batchResultResponse#',
  SUBSCRIPTION_GET_RESPONSE: 'vault.subscriptionGetResponse#',
} as const

