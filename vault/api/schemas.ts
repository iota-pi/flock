import { Type, Static } from '@sinclair/typebox'

// Reusable primitive fragments
const account = Type.String()
const item = Type.String()
const subscription = Type.String()

// Params
export const accountParams = Type.Object({ account }, { $id: 'vault.accountParams' })
export type AccountParams = Static<typeof accountParams>

export const itemParams = Type.Object({ account, item }, { $id: 'vault.itemParams' })
export type ItemParams = Static<typeof itemParams>

export const subscriptionParams = Type.Object({ account, subscription }, { $id: 'vault.subscriptionParams' })
export type SubscriptionParams = Static<typeof subscriptionParams>

// Bodies
export const itemBody = Type.Object(
  {
    cipher: Type.String(),
    iv: Type.String(),
    modified: Type.Number(),
    type: Type.String(),
  },
  { $id: 'vault.itemBody' },
)
export type ItemBody = Static<typeof itemBody>

export const itemsBody = Type.Array(
  Type.Object(
    {
      cipher: Type.String(),
      id: Type.String(),
      iv: Type.String(),
      modified: Type.Number(),
      type: Type.String(),
    },
    { $id: 'vault.itemsBody.item' },
  ),
  { $id: 'vault.itemsBody' },
)
export type ItemsBody = Static<typeof itemsBody>

export const subscriptionBody = Type.Object(
  {
    failures: Type.Number(),
    hours: Type.Array(Type.Number()),
    timezone: Type.String(),
    token: Type.String(),
  },
  { $id: 'vault.subscriptionBody' },
)
export type SubscriptionBody = Static<typeof subscriptionBody>

// Query schemas
export const itemsQuery = Type.Object(
  {
    since: Type.Optional(Type.String()),
    ids: Type.Optional(Type.String()),
  },
  { $id: 'vault.itemsQuery' },
)
export type ItemsQuery = Static<typeof itemsQuery>

// Export $ref constants to avoid typos when referencing registered schemas
export const ACCOUNT_PARAMS_REF = 'vault.accountParams#'
export const ITEM_PARAMS_REF = 'vault.itemParams#'
export const SUBSCRIPTION_PARAMS_REF = 'vault.subscriptionParams#'
export const ITEM_BODY_REF = 'vault.itemBody#'
export const ITEMS_BODY_REF = 'vault.itemsBody#'
export const SUBSCRIPTION_BODY_REF = 'vault.subscriptionBody#'
export const ITEMS_QUERY_REF = 'vault.itemsQuery#'
