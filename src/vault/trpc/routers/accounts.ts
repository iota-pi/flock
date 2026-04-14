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
} from '../../../shared/schemas/trpc'
import { hashString } from '../../api/util'
import { publishRealtimeEvent } from '../../realtime/hub'

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
      const loginAuthTokenHash = hashString(input.authToken)
      const valid = await ctx.vault.checkSession({
        account: input.account,
        session: loginAuthTokenHash,
        isLogin: true,
      })

      if (!valid.success) {
        throw new TRPCError({ code: 'UNAUTHORIZED' })
      }

      const accountData = await ctx.vault.getAccount({
        account: input.account,
        session: loginAuthTokenHash,
        isLogin: true,
      })

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
        session,
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
      const { salt, iterations } = await ctx.vault.getSecurityParams({ account: input.account })
      return {
        success: true,
        salt,
        iterations,
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
      const metadata = { ...(input.metadata || {}) }
      const expectedParentVersionId = typeof metadata._expectedParentVersionId === 'string'
        ? metadata._expectedParentVersionId
        : undefined
      delete metadata._expectedParentVersionId

      await ctx.vault.updateAccountData({
        account: input.account,
        metadata,
        expectedMetadataParentVersionId: expectedParentVersionId,
      })

      await publishRealtimeEvent(input.account, 'metadata.updated', {
        source: 'updateMetadata',
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

      await publishRealtimeEvent(input.account, 'metadata.updated', {
        source: 'addPushSubscription',
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

      await publishRealtimeEvent(input.account, 'metadata.updated', {
        source: 'deletePushSubscription',
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

      await publishRealtimeEvent(input.account, 'metadata.updated', {
        source: 'updateReminderSettings',
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
      await publishRealtimeEvent(input.account, 'metadata.updated', {
        source: 'recordPrayerCompletion',
      })
      return { success: true }
    }),
})