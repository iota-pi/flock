import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type BaseDriver from '../drivers/base'
import { hashString } from '../api/util'

type TrpcContext = {
  authTokenHash: string,
  authTokenRaw: string,
  vault: BaseDriver,
}

function getTokenFromAuthorizationHeader(authorizationHeader?: string): string {
  if (!authorizationHeader) {
    return ''
  }
  return authorizationHeader.replace(/^[a-z]+ /i, '')
}

function getAccountFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }

  const maybeInput = input as { account?: unknown }
  if (typeof maybeInput.account === 'string') {
    return maybeInput.account
  }

  return undefined
}

export function createContext({ req }: CreateFastifyContextOptions): TrpcContext {
  const authTokenRaw = getTokenFromAuthorizationHeader(req.headers.authorization)
  const authTokenHash = authTokenRaw ? hashString(authTokenRaw) : ''
  const serverWithVault = req.server as typeof req.server & { vault: BaseDriver }

  return {
    authTokenHash,
    authTokenRaw,
    vault: serverWithVault.vault,
  }
}

const t = initTRPC.context<typeof createContext>().create()

export const router = t.router
export const publicProcedure = t.procedure

export const protectedProcedure = t.procedure.use(async ({ ctx, input, next }) => {
  if (!ctx.authTokenRaw || !ctx.authTokenHash) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }

  const account = getAccountFromInput(input)
  if (!account) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }

  const validSession = await ctx.vault.checkSession({
    account,
    session: ctx.authTokenHash,
  })

  if (!validSession.success) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }

  ctx.vault.extendSession({ account }).catch(() => {})

  return next({
    ctx: {
      ...ctx,
      account,
    },
  })
})
