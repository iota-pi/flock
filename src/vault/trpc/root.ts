import { router } from './trpc'
import { accountsRouter } from './routers/accounts'
import { itemsRouter } from './routers/items'

export const appRouter = router({
  accounts: accountsRouter,
  items: itemsRouter,
})

export type AppRouter = typeof appRouter