import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type BaseDriver from '../drivers/base'
import type { VaultAccountWithAuth } from '../drivers/base'
import { AccountInputSchema } from '../../shared/schemas/trpc'
import { safeEqual } from '../util'

export const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const SESSION_RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000 // 1 day
export const SESSION_RENEWAL_THRESHOLD_MS = SESSION_EXPIRY_MS - SESSION_RENEWAL_WINDOW_MS // 29 days

export function shouldRenewSession(
  accountData: Pick<VaultAccountWithAuth, 'sessions'>,
  authToken: string,
  now = Date.now(),
): boolean {
  const currentSession = accountData.sessions?.find(s => safeEqual(authToken, s.token))

  if (!currentSession) {
    return true
  }

  const expiry = currentSession.expiry ?? (currentSession as { expires?: number }).expires
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) {
    return true
  }

  return expiry - now < SESSION_RENEWAL_THRESHOLD_MS
}

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

    let accountData: VaultAccountWithAuth
    try {
      accountData = await ctx.vault.getAccount({
        account,
        session: ctx.authToken,
      })
    } catch {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }

    if (!accountData) {
      throw new TRPCError({ code: 'UNAUTHORIZED' })
    }

    let extendSessionPromise: Promise<void> | null = null
    if (shouldRenewSession(accountData, ctx.authToken)) {
      extendSessionPromise = (
        ctx.vault.extendSession({ account, session: ctx.authToken })
          .catch(error => console.error('[extendSession failed]', error))
      )
    }

    const result = await next({
      ctx: {
        ...ctx,
        account,
        accountData,
      },
    })

    if (extendSessionPromise) {
      await extendSessionPromise
    }

    return result
  })
