import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type BaseDriver from '../drivers/base'
import { AccountInputSchema } from '../../shared/schemas/trpc'

type TrpcContext = {
  authToken: string,
  vault: BaseDriver,
}

function getTokenFromAuthorizationHeader(authorizationHeader?: string): string {
  if (!authorizationHeader) {
    return ''
  }

  // In case multiple Authorization values are coalesced into one header,
  // prefer the last bearer/basic token value.
  const latestHeaderValue = authorizationHeader.split(',').pop()?.trim() || authorizationHeader
  return latestHeaderValue.replace(/^[a-z]+\s+/i, '').trim()
}

export function createContext({ req }: CreateFastifyContextOptions): TrpcContext {
  const authToken = getTokenFromAuthorizationHeader(req.headers.authorization)
  const serverWithVault = req.server as typeof req.server & { vault: BaseDriver }

  return {
    authToken,
    vault: serverWithVault.vault,
  }
}

const t = initTRPC.context<typeof createContext>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure
  .input(AccountInputSchema)
  .use(async ({ ctx, input, next }) => {
    if (!ctx.authToken) {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }

    const { account } = input

    const validSession = await ctx.vault.checkSession({
      account,
      session: ctx.authToken,
    })

    if (!validSession.success) {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }

    ctx.vault.extendSession({ account, session: ctx.authToken }).catch(() => {})

    return next({
      ctx: {
        ...ctx,
        account,
      },
    })
  })
