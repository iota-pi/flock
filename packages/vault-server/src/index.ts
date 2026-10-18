// Server entry point: the tRPC context and routers, services and the driver interface. The DynamoDB
// driver is `@vault/server/dynamo`.

export * from './trpc/trpc'
export * from './sessions'
export * from './trpc/vaultRouter'
export { accountsRouter } from './trpc/routers/accounts'
export { itemsRouter } from './trpc/routers/items'
export { syncRouter } from './trpc/routers/sync'
export * from './services/dataVersion'
export { default as BaseDriver } from './drivers/base'
export type * from './drivers/base'
export * from './drivers/errors'
