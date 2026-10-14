import { mergeRouters, router } from './trpc'
import { accountsRouter } from './routers/accounts'
import { flockAccountsRouter } from './routers/flockAccounts'
import { itemsRouter } from './routers/items'
import { syncRouter } from './routers/sync'

// Flock's procedures live under `accounts` alongside the vault's so that installed clients keep working
export const appRouter = router({
  accounts: mergeRouters(accountsRouter, flockAccountsRouter),
  items: itemsRouter,
  sync: syncRouter,
})

export type AppRouter = typeof appRouter
