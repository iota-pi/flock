import { randomBytes } from 'crypto'
import { TRPCError } from '@trpc/server'
import { router, publicProcedure, protectedProcedure } from '../trpc'
import {
  AccountInputSchema,
  CreateAccountBodySchema,
  LoginBodySchema,
  PrayerCompletionBodySchema,
  PushSubscriptionBodySchema,
  PushSubscriptionDeleteBodySchema,
  ReminderSettingsBodySchema,
  UpdateMetadataBodySchema,
} from '../schemas'
import { hashString } from '../../api/util'

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
        session: randomBytes(16).toString('base64'),
      })

      if (!success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to create account' })
      }

      return { account }
    }),

  login: publicProcedure
    .input(LoginBodySchema)
    .mutation(async ({ ctx, input }) => {
      const valid = await ctx.vault.checkSession({
        account: input.account,
        session: hashString(input.authToken),
        isLogin: true,
      })

      if (!valid.success) {
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      const session = randomBytes(16).toString('base64')
      const sessionHash = hashString(session)
      await ctx.vault.updateAccountData({
        account: input.account,
        session: sessionHash,
      })

      return {
        success: true,
        session,
      }
    }),

  getSalt: publicProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const salt = await ctx.vault.getAccountSalt({ account: input.account })
      return {
        success: true,
        salt,
      }
    }),

  getMetadata: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx, input }) => {
      const { metadata } = await ctx.vault.getAccount({
        account: input.account,
        session: ctx.authTokenHash,
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
        session: ctx.authTokenHash,
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
        session: ctx.authTokenHash,
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
        session: ctx.authTokenHash,
      })

      return {
        success: true,
        reminderEnabled: existingAccount.reminderEnabled ?? false,
        reminderTime: existingAccount.reminderTime ?? '08:00',
        reminderTimezone: existingAccount.reminderTimezone ?? 'UTC',
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

  recordPrayerCompletion: protectedProcedure
    .input(PrayerCompletionBodySchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.updateAccountData({
        account: input.account,
        lastPrayerCompletedAt: input.completedAt,
      })
      return { success: true }
    }),
})