import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type BaseDriver from '../drivers/base'
import type { VaultAccountWithAuth } from '../drivers/base'
import {
  AccountInputSchema,
  CLIENT_OUTDATED_MESSAGE,
  parseProtocolVersion,
  PROTOCOL_VERSION_HEADER,
} from '@vault/shared'
import type { DataVersionPolicy } from '../services/dataVersion'
import { AuthenticationError } from '../drivers/errors'
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

export interface VaultServerOptions {
  /**
   * Writes from builds below this protocol version are rejected with `CLIENT_OUTDATED_MESSAGE`,
   * which makes the client update itself. Raise it to retire server code that only old builds need.
   */
  minProtocolVersion?: number
  /** Decides when an account's `dataVersion` can be raised. Without one, it never is. */
  dataVersionPolicy?: DataVersionPolicy
}

type TrpcContext = {
  authToken: string,
  vault: BaseDriver,
  /** The protocol version the client sent (0 for builds that predate the header) */
  protocolVersion?: number,
  minProtocolVersion?: number,
  dataVersionPolicy?: DataVersionPolicy,
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

export function createVaultContext(options: VaultServerOptions = {}) {
  return ({ req }: CreateFastifyContextOptions): TrpcContext => {
    const authToken = getTokenFromAuthorizationHeader(req.headers.authorization)
    const serverWithVault = req.server as typeof req.server & { vault: BaseDriver }

    return {
      authToken,
      vault: serverWithVault.vault,
      protocolVersion: parseProtocolVersion(req.headers[PROTOCOL_VERSION_HEADER]),
      minProtocolVersion: options.minProtocolVersion ?? 0,
      dataVersionPolicy: options.dataVersionPolicy,
    }
  }
}

const t = initTRPC.context<TrpcContext>().create()

export const router = t.router
export const mergeRouters = t.mergeRouters

/** Rejects writes from builds below the minimum protocol version. Reads stay open to them. */
export const publicProcedure = t.procedure.use(({ ctx, type, next }) => {
  const minProtocolVersion = ctx.minProtocolVersion ?? 0
  if (type === 'mutation' && (ctx.protocolVersion ?? 0) < minProtocolVersion) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: CLIENT_OUTDATED_MESSAGE })
  }
  return next()
})

export const protectedProcedure = publicProcedure
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
    } catch (error) {
      // Anything else (such as a DynamoDB timeout) is a server error: reporting it as UNAUTHORIZED
      // would make the client drop its session
      if (error instanceof AuthenticationError) {
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }
      throw error
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

    try {
      return await next({
        ctx: {
          ...ctx,
          account,
          accountData,
        },
      })
    } finally {
      if (extendSessionPromise) {
        await extendSessionPromise
      }
    }
  })
