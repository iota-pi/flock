import { randomBytes } from 'crypto'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure, protectedProcedure } from '../trpc'
import {
  AccountInputSchema,
  CreateAccountBodySchema,
  LoginBodySchema,
  UpdateKeyringBodySchema,
  ChangePasswordBodySchema,
  TOO_MANY_REQUESTS_MESSAGE,
  VersionConflictError,
} from '@vault/shared'
import { fakeSalt, generateAccountId, hashString } from '../../util'
import { addSessionRecord, findSession, SESSION_EXPIRY_MS } from '../../sessions'
import { raiseDataVersion } from '../../services/dataVersion'
import { AuthenticationError, TooManyLoginAttemptsError } from '../../errors'
import { authenticateLogin, matchesAuthTokenHash } from '../../authentication'
import { toTrpcError } from '../errors'
import type { StoredAccount, VaultAccountWithAuth } from '../../drivers/vaultDriver'
import type { KdfParams } from '@vault/shared'
import type { UnknownAccountParams } from '../trpc'
import type { DataVersionPolicy } from '../../services/dataVersion'

// Each attempt is a single conditional write, and a collision between random IDs is very unlikely
const MAX_CREATE_ACCOUNT_ATTEMPTS = 10

/** What a client needs to derive an account's master key, plus its data version */
interface SecurityParams {
  salt: string,
  iterations?: number,
  saltVersion?: number,
  kdf?: KdfParams,
  dataVersion?: number,
}

/** Credential changes need the current password as well as the session */
function assertCurrentAuthToken(accountData: VaultAccountWithAuth, currentAuthToken: string): void {
  if (!matchesAuthTokenHash(accountData, hashString(currentAuthToken))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Incorrect current password' })
  }
}

function accountSecurityParams(record: StoredAccount): SecurityParams {
  return {
    // Accounts from before per-account salts used the account ID as the salt
    salt: typeof record.salt === 'string' ? record.salt : record.account,
    iterations: record.iterations,
    saltVersion: record.saltVersion,
    kdf: record.kdf,
    dataVersion: record.dataVersion,
  }
}

/**
 * Made-up security parameters for an account that doesn't exist. They look like an account that has
 * nothing to migrate, so that logging in fails as for a wrong password.
 */
function unknownAccountSecurityParams(
  account: string,
  fake: UnknownAccountParams,
  dataVersionPolicy?: DataVersionPolicy,
): SecurityParams {
  return {
    salt: fakeSalt(account, fake.secret),
    iterations: fake.iterations,
    saltVersion: fake.saltVersion,
    kdf: fake.kdf,
    dataVersion: dataVersionPolicy?.current,
  }
}

export const accountsRouter = router({
  createAccount: publicProcedure
    .input(CreateAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      for (let attempt = 0; attempt < MAX_CREATE_ACCOUNT_ATTEMPTS; attempt += 1) {
        const account = generateAccountId()
        // Returns false if the ID is already taken, in which case we try another one
        const created = await ctx.vault.createAccount({
          account,
          authToken: hashString(input.authToken),
          salt: input.salt,
          saltVersion: input.saltVersion,
          kdf: input.kdf,
          keyring: input.keyring,
          randomDataKeys: input.randomDataKeys,
        })
        if (created) {
          return { account }
        }
      }

      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create account' })
    }),

  login: publicProcedure
    .input(LoginBodySchema)
    .mutation(async ({ ctx, input }) => {
      const record = await ctx.vault.getAccountRecord({ account: input.account })
      try {
        authenticateLogin(record, hashString(input.authToken))
      } catch (error) {
        if (error instanceof AuthenticationError) {
          // Failing to count it mustn't turn a wrong password into a server error
          await ctx.vault.recordFailedLogin({ account: input.account }).catch(countError => {
            console.warn('[accounts.login] Could not count a failed login:', countError)
          })
        }
        throw toTrpcError(error, [
          { error: TooManyLoginAttemptsError, code: 'TOO_MANY_REQUESTS', message: TOO_MANY_REQUESTS_MESSAGE },
          { error: AuthenticationError, code: 'UNAUTHORIZED' },
        ])
      }

      // The driver adds it with a conditional write, so concurrent logins don't drop each other's sessions
      const session = randomBytes(16).toString('base64')
      await ctx.vault.addSession({
        account: input.account,
        session,
        expiry: Date.now() + SESSION_EXPIRY_MS,
      })

      return {
        success: true,
        session,
      }
    }),

  getSecurityParams: publicProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const record = await ctx.vault.getAccountRecord({ account: input.account })
      let params: SecurityParams
      if (record) {
        params = accountSecurityParams(record)
      } else if (ctx.unknownAccountParams) {
        params = unknownAccountSecurityParams(input.account, ctx.unknownAccountParams, ctx.dataVersionPolicy)
      } else {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
      }

      return {
        success: true,
        ...params,
        // Returned before login, so that the app can route accounts that need migrating
        dataVersion: params.dataVersion ?? 0,
      }
    }),

  // Clients call this once their migrations have run. Returns why it couldn't be raised, if it couldn't.
  raiseDataVersion: protectedProcedure
    .mutation(async ({ ctx, input }) => {
      const result = await raiseDataVersion(ctx.vault, {
        account: input.account,
        accountData: ctx.accountData,
        policy: ctx.dataVersionPolicy,
      })
      return { success: true, ...result }
    }),

  getKeyring: protectedProcedure
    .query(async ({ ctx }) => {
      return {
        success: true,
        keyring: ctx.accountData.keyring,
        randomDataKeys: ctx.accountData.randomDataKeys === true,
      }
    }),

  updateKeyring: protectedProcedure
    .input(UpdateKeyringBodySchema)
    .mutation(async ({ ctx, input }) => {
      assertCurrentAuthToken(ctx.accountData, input.currentAuthToken)

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          keyring: input.keyring,
          keyringVersion: input.keyringVersion,
          expectedKeyringVersion: input.expectedKeyringVersion,
        })
      } catch (error) {
        throw toTrpcError(error, [
          { error: VersionConflictError, code: 'CONFLICT', message: 'Concurrent key rotation detected: keyringVersion conflict' },
        ])
      }

      return { success: true }
    }),

  changePassword: protectedProcedure
    .input(ChangePasswordBodySchema)
    .mutation(async ({ ctx, input }) => {
      assertCurrentAuthToken(ctx.accountData, input.currentAuthToken)

      const newAuthTokenHash = hashString(input.newAuthToken)

      // Changing the password ends every other session
      const currentSessionExpiry = findSession(ctx.accountData.sessions, ctx.authToken)?.expiry
        ?? Date.now() + SESSION_EXPIRY_MS

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          authToken: newAuthTokenHash,
          salt: input.newSalt,
          kdf: input.newKdf,
          keyring: input.newKeyring,
          saltVersion: input.saltVersion,
          keyringVersion: input.keyringVersion,
          expectedKeyringVersion: input.expectedKeyringVersion,
          sessions: addSessionRecord([], ctx.authToken, currentSessionExpiry),
        })
      } catch (error) {
        throw toTrpcError(error, [
          { error: VersionConflictError, code: 'CONFLICT', message: 'Concurrent credential update detected: keyringVersion conflict' },
        ])
      }

      return { success: true }
    }),
})