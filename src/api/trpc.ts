import { createTRPCReact } from '@trpc/react-query'
import type { AppRouter } from '../vault/trpc/root'

export const trpc = createTRPCReact<AppRouter>()