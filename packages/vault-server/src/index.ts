// Server entry point: the tRPC context and routers, services and the driver interface. The DynamoDB
// driver is `@vault/server/dynamo`.

export * from './trpc/trpc'
export * from './sessions'
export * from './authentication'
export * from './trpc/vaultRouter'
export { accountsRouter } from './trpc/routers/accounts'
export { itemsRouter } from './trpc/routers/items'
export { syncRouter } from './trpc/routers/sync'
export * from './services/dataVersion'
export type * from './drivers/vaultDriver'
export * from './errors'
