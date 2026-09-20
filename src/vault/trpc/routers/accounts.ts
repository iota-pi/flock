import { randomBytes } from 'crypto'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure, protectedProcedure } from '../trpc'
import {
  AccountInputSchema,
  CreateAccountBodySchema,
  LoginBodySchema,
  SnoozeRemindersBodySchema,
  PushSubscriptionBodySchema,
  PushSubscriptionDeleteBodySchema,
  ReminderSettingsBodySchema,
  UpdateMetadataBodySchema,
  UpdateKeyringBodySchema,
  ChangePasswordBodySchema,
} from 'src/shared/schemas/trpc'
import { toZonedTime } from 'date-fns-tz'
import { hashString } from '../../api/util'


const SESSION_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000
const MAX_ACTIVE_SESSIONS = 8

export const accountsRouter = router({
  createAccount: publicProcedure
    .input(CreateAccountBodySchema)
    .mutation(async ({ ctx, input }) => {
      const account = await ctx.vault.getNewAccountId()

      const success = await ctx.vault.createAccount({
        account,
        authToken: hashString(input.authToken),
        metadata: {},
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
      const loginAuthTokenHash = hashString(input.authToken)
      let accountData
      try {
        accountData = await ctx.vault.getAccount({
          account: input.account,
          session: loginAuthTokenHash,
          isLogin: true,
        })
      } catch (_) {
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      const session = randomBytes(16).toString('base64')
      const now = Date.now()
      const existingSessions = Array.isArray(accountData.sessions)
        ? accountData.sessions
          .filter(entry => typeof entry?.token === 'string' && typeof entry?.expiry === 'number' && entry.expiry > now)
          .map(entry => ({ token: entry.token, expiry: entry.expiry }))
        : []

      const nextSessions = [
        ...existingSessions.filter(entry => entry.token !== session),
        {
          token: session,
          expiry: now + SESSION_EXPIRY_MS,
        },
      ].slice(-MAX_ACTIVE_SESSIONS)

      await ctx.vault.updateAccountData({
        account: input.account,
        sessions: nextSessions,
      })

      return {
        success: true,
        session,
      }
    }),

  getSecurityParams: publicProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const { salt, iterations, saltVersion } = await ctx.vault.getSecurityParams({ account: input.account })
      return {
        success: true,
        salt,
        iterations,
        saltVersion,
      }
    }),

  getMetadata: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const { metadata } = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      return {
        success: true,
        metadata,
      }
    }),

  updateMetadata: protectedProcedure
    .input(UpdateMetadataBodySchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.updateAccountData({
        account: input.account,
        metadata: input.metadata || {},
      })

      return { success: true }
    }),

  addPushSubscription: protectedProcedure
    .input(PushSubscriptionBodySchema)
    .mutation(async ({ ctx, input }) => {
      const existingAccount = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      const existing = existingAccount.pushSubscriptions ?? []
      const incoming = {
        endpoint: input.endpoint,
        keys: input.keys,
      }
      const next = existing.some(sub => sub.endpoint === incoming.endpoint)
        ? existing
        : [...existing, incoming]

      await ctx.vault.updateAccountData({
        account: input.account,
        pushSubscriptions: next,
      })

      return { success: true }
    }),

  deletePushSubscription: protectedProcedure
    .input(PushSubscriptionDeleteBodySchema)
    .mutation(async ({ ctx, input }) => {
      const existingAccount = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      const existing = existingAccount.pushSubscriptions ?? []
      const next = existing.filter(sub => sub.endpoint !== input.endpoint)

      await ctx.vault.updateAccountData({
        account: input.account,
        pushSubscriptions: next,
      })

      return { success: true }
    }),

  getReminderSettings: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const existingAccount = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      return {
        success: true,
        reminderEnabled: existingAccount.reminderEnabled ?? false,
        reminderTime: existingAccount.reminderTime ?? '08:00',
        reminderTimezone: existingAccount.reminderTimezone ?? 'UTC',
        snoozeRemindersUntil: existingAccount.snoozeRemindersUntil,
      }
    }),

  updateReminderSettings: protectedProcedure
    .input(ReminderSettingsBodySchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.updateAccountData({
        account: input.account,
        reminderEnabled: input.reminderEnabled,
        reminderTime: input.reminderTime,
        reminderTimezone: input.reminderTimezone,
      })

      return { success: true }
    }),

  snoozeReminders: protectedProcedure
    .input(SnoozeRemindersBodySchema)
    .mutation(async ({ ctx, input }) => {
      let targetDate = input.snoozeUntilDate
      if (targetDate === undefined) {
        const existingAccount = await ctx.vault.getAccount({
          account: input.account,
          session: ctx.authToken,
        })
        const timezone = existingAccount.reminderTimezone ?? 'UTC'
        const zoned = toZonedTime(new Date(), timezone)
        const tomorrow = new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate() + 1)
        const year = tomorrow.getFullYear()
        const month = String(tomorrow.getMonth() + 1).padStart(2, '0')
        const day = String(tomorrow.getDate()).padStart(2, '0')
        targetDate = `${year}-${month}-${day}`
      }

      await ctx.vault.updateAccountData({
        account: input.account,
        snoozeRemindersUntil: targetDate,
      })

      return { success: true, snoozeRemindersUntil: targetDate }
    }),

  getKeyring: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const accountData = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      return {
        success: true,
        keyring: accountData.keyring,
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
      const accountData = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authToken,
      })

      const currentAuthTokenHash = hashString(input.currentAuthToken)
      if (accountData.authToken !== currentAuthTokenHash) {
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