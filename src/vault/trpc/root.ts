import { mergeRouters, router } from '@vault/server/trpc'
import { accountsRouter } from '@vault/server/routers/accounts'
import { flockAccountsRouter } from './routers/flockAccounts'
import { itemsRouter } from '@vault/server/routers/items'
import { syncRouter } from '@vault/server/routers/sync'

// Flock's procedures live under `accounts` alongside the vault's so that installed clients keep working
export const appRouter = router({
  accounts: mergeRouters(accountsRouter, flockAccountsRouter),
  items: itemsRouter,
  sync: syncRouter,
})

export type AppRouter = typeof appRouter
