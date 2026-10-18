import { randomBytes } from 'crypto'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure, protectedProcedure, SESSION_EXPIRY_MS } from '../trpc'
import {
  AccountInputSchema,
  CreateAccountBodySchema,
  LoginBodySchema,
  UpdateKeyringBodySchema,
  ChangePasswordBodySchema,
} from '@vault/shared'
import { hashString, safeEqual } from '../../util'
import { raiseDataVersion } from '../../services/dataVersion'
import { AuthenticationError } from '../../drivers/errors'


export const accountsRouter = router({
  createAccount: publicProcedure
    .input(CreateAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      const account = await ctx.vault.getNewAccountId()

      const success = await ctx.vault.createAccount({
        account,
        authToken: hashString(input.authToken),
        salt: input.salt,
        iterations: input.iterations,
        saltVersion: input.saltVersion,
      })

      if (!success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create account' })
      }

      return { account }
    }),

  login: publicProcedure
    .input(LoginBodySchema)
    .mutation(async ({ ctx, input }) => {
      try {
        await ctx.vault.getAccount({
          account: input.account,
          session: hashString(input.authToken),
          isLogin: true,
        })
      } catch (error) {
        if (error instanceof AuthenticationError) {
          throw new TRPCError({ code: 'UNAUTHORIZED' })
        }
        throw error
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
      const { salt, iterations, saltVersion, dataVersion } = await ctx.vault.getSecurityParams({ account: input.account })
      return {
        success: true,
        salt,
        iterations,
        saltVersion,
        // Returned before login, so that the app can route accounts that need migrating
        dataVersion: dataVersion ?? 0,
      }
    }),

  // Clients call this once their migrations have run. Returns why it couldn't be raised, if it couldn't.
  raiseDataVersion: protectedProcedure
    .input(AccountInputSchema)
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
    .input(AccountInputSchema)
    .query(async ({ ctx }) => {
      return {
        success: true,
        keyring: ctx.accountData.keyring,
      }
    }),

  updateKeyring: protectedProcedure
    .input(UpdateKeyringBodySchema)
    .mutation(async ({ ctx, input }) => {
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
      } catch (err) {
        if (
          err instanceof Error && (
            err.name === 'ConditionalCheckFailedException'
            || err.message.includes('ConditionalCheckFailed')
          )
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Concurrent key rotation detected: keyringVersion conflict',
          })
        }
        throw err
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

      const now = Date.now()
      const currentSessionToken = ctx.authToken
      const currentSessionExpiry = accountData.sessions?.find(s => s.token === currentSessionToken)?.expiry ?? (now + 30 * 24 * 60 * 60 * 1000)

      try {
        await ctx.vault.updateAccountData({
          account: input.account,
          authToken: newAuthTokenHash,
          salt: input.newSalt,
          iterations: input.newIterations,
          keyring: input.newKeyring,
          saltVersion: input.saltVersion,
          ...(typeof input.keyringVersion === 'number'
            ? { keyringVersion: input.keyringVersion }
            : {}),
          ...(typeof input.expectedKeyringVersion === 'number'
            ? { expectedKeyringVersion: input.expectedKeyringVersion }
            : {}),
          sessions: [{ token: currentSessionToken, expiry: currentSessionExpiry }],
        })
      } catch (err) {
        if (
          err instanceof Error && (
            err.name === 'ConditionalCheckFailedException'
            || err.message.includes('ConditionalCheckFailed')
          )
        ) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Concurrent credential update detected: keyringVersion conflict',
          })
        }
        throw err
      }

      return { success: true }
    }),
})