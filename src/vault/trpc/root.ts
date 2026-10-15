import { mergeRouters, router, accountsRouter, itemsRouter, syncRouter } from '@vault/server'
import { flockAccountsRouter } from './routers/flockAccounts'
import { migrationRouter } from './routers/migration'

// Flock's procedures live under `accounts` alongside the vault's so that installed clients keep working
export const appRouter = router({
  accounts: mergeRouters(accountsRouter, flockAccountsRouter),
  items: itemsRouter,
  sync: syncRouter,
  migration: migrationRouter,
})

export type AppRouter = typeof appRouter
