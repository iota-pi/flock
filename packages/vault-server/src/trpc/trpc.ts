import { initTRPC, TRPCError } from '@trpc/server'
import type { CreateFastifyContextOptions } from '@trpc/server/adapters/fastify'
import type { VaultAccountWithAuth, VaultDriver } from '../drivers/vaultDriver'
import {
  AccountInputSchema,
  CLIENT_OUTDATED_MESSAGE,
  parseProtocolVersion,
  PROTOCOL_VERSION_HEADER,
} from '@vault/shared'
import type { KdfParams } from '@vault/shared'
import type { DataVersionPolicy } from '../services/dataVersion'
import { AuthenticationError } from '../errors'
import { authenticateSession } from '../authentication'
import { shouldRenewSession } from '../sessions'
import { toTrpcError } from './errors'
import { DEFAULT_ACCOUNT_QUOTAS, type AccountQuotas } from '../quotas'

export interface VaultServerOptions {
  /** The storage every request runs on */
  vault: VaultDriver
  /**
   * Writes from builds below this protocol version are rejected with `CLIENT_OUTDATED_MESSAGE`,
   * which makes the client update itself. Raise it to retire server code that only old builds need.
   */
  minProtocolVersion?: number
  /** Decides when an account's `dataVersion` can be raised. Without one, it never is. */
  dataVersionPolicy?: DataVersionPolicy
  /**
   * Made-up security parameters for accounts that don't exist, so that `getSecurityParams` doesn't
   * reveal which accounts do. The salt is an HMAC of the account ID with `secret`, so it is the same
   * on every request; keep the secret stable and private. Set `kdf` (or, for apps still creating
   * PBKDF2 accounts, `iterations`) and `saltVersion` to what new accounts use, so the response looks
   * like a real account's. Without this, unknown accounts get NOT_FOUND.
   */
  unknownAccountParams?: UnknownAccountParams
  /** Overrides some of `DEFAULT_ACCOUNT_QUOTAS` */
  quotas?: Partial<AccountQuotas>
}

export interface UnknownAccountParams {
  secret: string
  iterations?: number
  saltVersion?: number
  kdf?: KdfParams
}

type TrpcContext = Required<Pick<VaultServerOptions, 'vault' | 'minProtocolVersion'>>
  & Pick<VaultServerOptions, 'dataVersionPolicy' | 'unknownAccountParams'>
  & {
    authToken: string,
    /** The protocol version the client sent (0 for builds that predate the header) */
    protocolVersion: number,
    quotas: AccountQuotas,
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

export function createVaultContext(options: VaultServerOptions) {
  return ({ req }: CreateFastifyContextOptions): TrpcContext => {
    const authToken = getTokenFromAuthorizationHeader(req.headers.authorization)

    return {
      authToken,
      vault: options.vault,
      protocolVersion: parseProtocolVersion(req.headers[PROTOCOL_VERSION_HEADER]),
      minProtocolVersion: options.minProtocolVersion ?? 0,
      dataVersionPolicy: options.dataVersionPolicy,
      unknownAccountParams: options.unknownAccountParams,
      quotas: { ...DEFAULT_ACCOUNT_QUOTAS, ...options.quotas },
    }
  }
}

/** What clients see in place of an unexpected error's own message */
const INTERNAL_ERROR_MESSAGE = 'Internal server error'

const t = initTRPC.context<TrpcContext>().create({
  // tRPC's default is NODE_ENV !== 'production', and nothing sets NODE_ENV on Lambda, so error
  // responses would carry the server's stack traces
  isDev: false,
  // An unexpected error's message can hold internal details (a DynamoDB error, an account ID), so
  // clients only get a generic one. onError still logs the real error.
  errorFormatter: ({ shape }) => shape.data.code === 'INTERNAL_SERVER_ERROR'
    ? { ...shape, message: INTERNAL_ERROR_MESSAGE }
    : shape,
})

export const router = t.router
export const mergeRouters = t.mergeRouters

/** Rejects writes from builds below the minimum protocol version. Reads stay open to them. */
export const publicProcedure = t.procedure.use(({ ctx, type, next }) => {
  if (type === 'mutation' && ctx.protocolVersion < ctx.minProtocolVersion) {
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

    // A failed read (such as a DynamoDB timeout) is a server error: reporting it as UNAUTHORIZED
    // would make the client drop its session
    const record = await ctx.vault.getAccountRecord({ account })
    let accountData: VaultAccountWithAuth
    try {
      accountData = authenticateSession(record, ctx.authToken)
    } catch (error) {
      throw toTrpcError(error, [{ error: AuthenticationError, code: 'UNAUTHORIZED' }])
    }

    const extendSessionPromise = shouldRenewSession(accountData, ctx.authToken)
      ? ctx.vault.extendSession({ account, session: ctx.authToken })
        .catch(error => console.error('[extendSession failed]', error))
      : undefined

    try {
      return await next({
        ctx: {
          ...ctx,
          accountData,
        },
      })
    } finally {
      await extendSessionPromise
    }
  })
