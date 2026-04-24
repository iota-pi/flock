import { router } from './trpc'
import { accountsRouter } from './routers/accounts'
import { itemsRouter } from './routers/items'
import { syncRouter } from './routers/sync'

export const appRouter = router({
  accounts: accountsRouter,
  items: itemsRouter,
  sync: syncRouter,
})

export type AppRouter = typeof appRouter