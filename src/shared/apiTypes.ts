// Shared API wire types between frontend (app) and backend (vault)
// Uses TypeBox for runtime validation schemas with derived TypeScript types

import { Type, Static } from 'typebox'

// =============================================================================
// Core Types
// =============================================================================

export const ItemTypeSchema = Type.Union([
  Type.Literal('person'),
  Type.Literal('group'),
  Type.Literal('topic'),
])
export type ItemType = Static<typeof ItemTypeSchema>
export const ITEM_TYPES = ['person', 'group', 'topic'] as const

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

export const WebPushSubscriptionKeysSchema = Type.Object({
  p256dh: Type.String(),
  auth: Type.String(),
})
export type WebPushSubscriptionKeys = Static<typeof WebPushSubscriptionKeysSchema>

export const WebPushSubscriptionSchema = Type.Object({
  endpoint: Type.String(),
  keys: WebPushSubscriptionKeysSchema,
})
export type WebPushSubscription = Static<typeof WebPushSubscriptionSchema>

export const ReminderSettingsSchema = Type.Object({
  reminderEnabled: Type.Boolean({ default: false }),
  reminderTime: Type.String({ default: '08:00' }),
  reminderTimezone: Type.String({ default: 'UTC' }),
})
export type ReminderSettings = Static<typeof ReminderSettingsSchema>

export const AccountPushSettingsSchema = Type.Intersect([
  ReminderSettingsSchema,
  Type.Object({
    pushSubscriptions: Type.Array(WebPushSubscriptionSchema),
  }),
])
export type AccountPushSettings = Static<typeof AccountPushSettingsSchema>

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

export const PushSubscriptionBodySchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1 }),
    keys: WebPushSubscriptionKeysSchema,
  },
  { $id: 'vault.pushSubscriptionBody' },
)
export type PushSubscriptionBody = Static<typeof PushSubscriptionBodySchema>

export const PushSubscriptionDeleteBodySchema = Type.Object(
  {
    endpoint: Type.String({ minLength: 1 }),
  },
  { $id: 'vault.pushSubscriptionDeleteBody' },
)
export type PushSubscriptionDeleteBody = Static<typeof PushSubscriptionDeleteBodySchema>

export const ReminderSettingsBodySchema = Type.Object(
  {
    reminderEnabled: Type.Boolean(),
    reminderTime: Type.String({ minLength: 5, maxLength: 5 }),
    reminderTimezone: Type.String({ minLength: 1 }),
  },
  { $id: 'vault.reminderSettingsBody' },
)
export type ReminderSettingsBody = Static<typeof ReminderSettingsBodySchema>

export const PrayerCompletionBodySchema = Type.Object(
  {
    completedAt: Type.Number(),
  },
  { $id: 'vault.prayerCompletionBody' },
)
export type PrayerCompletionBody = Static<typeof PrayerCompletionBodySchema>

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

export const ReminderSettingsResponseSchema = Type.Object(
  {
    success: Type.Boolean(),
    reminderEnabled: Type.Boolean(),
    reminderTime: Type.String(),
    reminderTimezone: Type.String(),
  },
  { $id: 'vault.reminderSettingsResponse' },
)
export type ReminderSettingsResponse = Static<typeof ReminderSettingsResponseSchema>

// =============================================================================
// Schema $id References (for Fastify schema registration)
// =============================================================================

export const SCHEMA_REFS = {
  // Params
  ACCOUNT_PARAMS: 'vault.accountParams#',
  ITEM_PARAMS: 'vault.itemParams#',
  // Query
  ITEMS_QUERY: 'vault.itemsQuery#',
  // Bodies
  CREATE_ACCOUNT_BODY: 'vault.createAccountBody#',
  LOGIN_BODY: 'vault.loginBody#',
  UPDATE_METADATA_BODY: 'vault.updateMetadataBody#',
  ITEM_BODY: 'vault.itemBody#',
  ITEMS_BODY: 'vault.itemsBody#',
  DELETE_ITEMS_BODY: 'vault.deleteItemsBody#',
  PUSH_SUBSCRIPTION_BODY: 'vault.pushSubscriptionBody#',
  PUSH_SUBSCRIPTION_DELETE_BODY: 'vault.pushSubscriptionDeleteBody#',
  REMINDER_SETTINGS_BODY: 'vault.reminderSettingsBody#',
  PRAYER_COMPLETION_BODY: 'vault.prayerCompletionBody#',
  // Responses
  SUCCESS_RESPONSE: 'vault.successResponse#',
  ERROR_RESPONSE: 'vault.errorResponse#',
  ACCOUNT_CREATION_RESPONSE: 'vault.accountCreationResponse#',
  SALT_RESPONSE: 'vault.saltResponse#',
  SESSION_RESPONSE: 'vault.sessionResponse#',
  METADATA_RESPONSE: 'vault.metadataResponse#',
  ITEMS_RESPONSE: 'vault.itemsResponse#',
  BATCH_RESULT_RESPONSE: 'vault.batchResultResponse#',
  REMINDER_SETTINGS_RESPONSE: 'vault.reminderSettingsResponse#',
} as const

