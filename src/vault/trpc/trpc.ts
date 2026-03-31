import { initTRPC, TRPCError } from '@trpc/server'
import { middlewareMarker } from '@trpc/server/unstable-core-do-not-import'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type BaseDriver from '../drivers/base'
import { AccountInputSchema } from './schemas'

type TrpcContext = {
  authToken: string,
  vault: BaseDriver,
}

const IDEMPOTENCY_TTL_SECONDS = 5 * 60

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

    ctx.vault.extendSession({ account }).catch(() => {})

    return next({
      ctx: {
        ...ctx,
        account,
      },
    })
  })

export const idempotentMutationMiddleware = t.middleware(async ({ ctx, input, type, next }) => {
  if (type !== 'mutation') {
    return next()
  }

  if (!input || typeof input !== 'object') {
    return next()
  }

  const typedInput = input as {
    account?: unknown
    idempotencyKey?: unknown
    item?: unknown
    items?: unknown
    branches?: unknown
  }

  const usesTransactionalItemIdempotency = (
    (typeof typedInput.item === 'string' && Array.isArray(typedInput.branches))
    || Array.isArray(typedInput.items)
  )
  if (usesTransactionalItemIdempotency) {
    return next()
  }

  if (typeof typedInput.idempotencyKey !== 'string' || typedInput.idempotencyKey.length === 0) {
    return next()
  }

  if (typeof typedInput.account !== 'string' || typedInput.account.length === 0) {
    return next()
  }

  const expiresAt = Math.floor(Date.now() / 1000) + IDEMPOTENCY_TTL_SECONDS
  const claimed = await ctx.vault.claimIdempotencyKey(typedInput.account, typedInput.idempotencyKey, expiresAt)
  if (!claimed) {
    return {
      marker: middlewareMarker,
      ok: true,
      data: {
        success: true,
      },
    }
  }

  return next()
})

export const idempotentProtectedProcedure = protectedProcedure.use(idempotentMutationMiddleware)
