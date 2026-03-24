import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type BaseDriver from '../drivers/base'

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

function getAccountFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined
  }

  const toVisit: unknown[] = [input]
  const visited = new Set<object>()

  while (toVisit.length > 0) {
    const value = toVisit.pop()
    if (!value || typeof value !== 'object') {
      continue
    }
    if (visited.has(value)) {
      continue
    }
    visited.add(value)

    const recordValue = value as Record<string, unknown>
    if (typeof recordValue.account === 'string') {
      return recordValue.account
    }

    // Check common tRPC wrappers first to avoid unrelated deep traversal.
    if (recordValue.input !== undefined) {
      toVisit.push(recordValue.input)
    }
    if (recordValue.json !== undefined) {
      toVisit.push(recordValue.json)
    }

    for (const nestedValue of Object.values(recordValue)) {
      toVisit.push(nestedValue)
    }
  }

  return undefined
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

export const protectedProcedure = t.procedure.use(async ({ ctx, input, next }) => {
  if (!ctx.authToken) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }

  const account = getAccountFromInput(input)
  if (!account) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }

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
