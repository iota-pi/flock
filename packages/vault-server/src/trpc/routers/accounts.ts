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
import { fakeSalt, hashString, safeEqual } from '../../util'
import { hashSessionToken, isSessionFor, SESSION_EXPIRY_MS } from '../../sessions'
import { raiseDataVersion } from '../../services/dataVersion'
import { AuthenticationError, TooManyLoginAttemptsError } from '../../errors'
import { authenticateLogin } from '../../authentication'
import { toTrpcError } from '../errors'

const MAX_CREATE_ACCOUNT_ATTEMPTS = 3

export const accountsRouter = router({
  createAccount: publicProcedure
    .input(CreateAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      for (let attempt = 0; attempt < MAX_CREATE_ACCOUNT_ATTEMPTS; attempt += 1) {
        const account = await ctx.vault.getNewAccountId()
        // Fails if another sign-up took the ID after getNewAccountId checked it
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
      let params: Awaited<ReturnType<typeof ctx.vault.getSecurityParams>>
      try {
        params = await ctx.vault.getSecurityParams({ account: input.account })
      } catch (error) {
        if (!(error instanceof AuthenticationError)) {
          throw error
        }
        const fake = ctx.unknownAccountParams
        if (!fake) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
        }
        // Looks like an account that has nothing to migrate, so that logging in fails as for a wrong password
        params = {
          salt: fakeSalt(input.account, fake.secret),
          iterations: fake.iterations,
          saltVersion: fake.saltVersion,
          kdf: fake.kdf,
          dataVersion: ctx.dataVersionPolicy?.current,
        }
      }

      const { salt, iterations, saltVersion, kdf, dataVersion } = params
      return {
        success: true,
        salt,
        iterations,
        saltVersion,
        kdf,
        // Returned before login, so that the app can route accounts that need migrating
        dataVersion: dataVersion ?? 0,
      }
    }),

  // Clients call this once their migrations have run. Returns why it couldn't be raised, if it couldn't.
  raiseDataVersion: protectedProcedure
    .mutation(async ({ ctx, input }) => {
      const result = await raiseDataVersion({
        account: input.account,
        accountData: ctx.accountData,
        vault: ctx.vault,
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
      if (!safeEqual(ctx.accountData.authToken, hashString(input.currentAuthToken))) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Incorrect current password' })
      }

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          keyring: input.keyring,
          ...(typeof input.keyringVersion === 'number'
            ? { keyringVersion: input.keyringVersion }
            : {}),
          ...(typeof input.expectedKeyringVersion === 'number'
            ? { expectedKeyringVersion: input.expectedKeyringVersion }
            : {}),
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
      const accountData = ctx.accountData

      const currentAuthTokenHash = hashString(input.currentAuthToken)
      if (!safeEqual(accountData.authToken, currentAuthTokenHash)) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Incorrect current password' })
      }

      const newAuthTokenHash = hashString(input.newAuthToken)

      // Changing the password ends every other session
      const currentSessionExpiry = accountData.sessions?.find(s => isSessionFor(s, ctx.authToken))?.expiry
        ?? Date.now() + SESSION_EXPIRY_MS

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          authToken: newAuthTokenHash,
          salt: input.newSalt,
          kdf: input.newKdf,
          keyring: input.newKeyring,
          saltVersion: input.saltVersion,
          ...(typeof input.keyringVersion === 'number'
            ? { keyringVersion: input.keyringVersion }
            : {}),
          ...(typeof input.expectedKeyringVersion === 'number'
            ? { expectedKeyringVersion: input.expectedKeyringVersion }
            : {}),
          sessions: [{ token: hashSessionToken(ctx.authToken), expiry: currentSessionExpiry }],
        })
      } catch (error) {
        throw toTrpcError(error, [
          { error: VersionConflictError, code: 'CONFLICT', message: 'Concurrent credential update detected: keyringVersion conflict' },
        ])
      }

      return { success: true }
    }),
})