import { router } from './trpc'
import { accountsRouter } from './routers/accounts'
import { itemsRouter } from './routers/items'
import { syncRouter } from './routers/sync'

/**
 * The vault's procedures. Apps mount these routers at the root of their own router, using
 * `mergeRouters` to add app-specific procedures to a namespace (see root.ts).
 */
export const vaultRouter = router({
  accounts: accountsRouter,
  items: itemsRouter,
  sync: syncRouter,
})

export type VaultRouter = typeof vaultRouter
