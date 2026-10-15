import { router, protectedProcedure } from '@vault/server'
import type { VaultAccountWithAuth } from '@vault/server'
import {
  SnoozeRemindersBodySchema,
  PushSubscriptionBodySchema,
  PushSubscriptionDeleteBodySchema,
  ReminderSettingsBodySchema,
} from 'src/shared/schemas/notifications'
import { LegacyMetadataBodySchema } from 'src/shared/schemas/metadata'
import { AccountInputSchema } from '@vault/shared'
import { toZonedTime } from 'date-fns-tz'
import type { FlockAccountFields } from '../../types'

function flockAccount(accountData: VaultAccountWithAuth): VaultAccountWithAuth & FlockAccountFields {
  return accountData as VaultAccountWithAuth & FlockAccountFields
}

/** Flock's account procedures (push subscriptions and reminders), merged into `accounts` in root.ts */
export const flockAccountsRouter = router({
  // Legacy plaintext settings. Clients now keep settings in an encrypted settings document and
  // migrate these into it once (see LegacySettingsSource). Remove after the deprecation window.
  getMetadata: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx }) => {
      return {
        success: true,
        metadata: flockAccount(ctx.accountData).metadata ?? {},
      }
    }),

  /** Cached clients still push their settings here. They are discarded rather than stored in plaintext. */
  updateMetadata: protectedProcedure
    .input(LegacyMetadataBodySchema)
    .mutation(async () => {
      return { success: true }
    }),

  clearMetadata: protectedProcedure
    .input(AccountInputSchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.updateAccountData<FlockAccountFields>({
        account: input.account,
        metadata: {},
      })

      return { success: true }
    }),

  addPushSubscription: protectedProcedure
    .input(PushSubscriptionBodySchema)
    .mutation(async ({ ctx, input }) => {
      const existing = flockAccount(ctx.accountData).pushSubscriptions ?? []
      const incoming = {
        endpoint: input.endpoint,
        keys: input.keys,
      }
      const next = existing.some(sub => sub.endpoint === incoming.endpoint)
        ? existing
        : [...existing, incoming]

      await ctx.vault.updateAccountData<FlockAccountFields>({
        account: input.account,
        pushSubscriptions: next,
      })

      return { success: true }
    }),

  deletePushSubscription: protectedProcedure
    .input(PushSubscriptionDeleteBodySchema)
    .mutation(async ({ ctx, input }) => {
      const existing = flockAccount(ctx.accountData).pushSubscriptions ?? []
      const next = existing.filter(sub => sub.endpoint !== input.endpoint)

      await ctx.vault.updateAccountData<FlockAccountFields>({
        account: input.account,
        pushSubscriptions: next,
      })

      return { success: true }
    }),

  getReminderSettings: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx }) => {
      const account = flockAccount(ctx.accountData)
      return {
        success: true,
        reminderEnabled: account.reminderEnabled ?? false,
        reminderTime: account.reminderTime ?? '08:00',
        reminderTimezone: account.reminderTimezone ?? 'UTC',
        snoozeRemindersUntil: account.snoozeRemindersUntil,
      }
    }),

  updateReminderSettings: protectedProcedure
    .input(ReminderSettingsBodySchema)
    .mutation(async ({ ctx, input }) => {
      await ctx.vault.updateAccountData<FlockAccountFields>({
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
        const timezone = flockAccount(ctx.accountData).reminderTimezone ?? 'UTC'
        const zoned = toZonedTime(new Date(), timezone)
        const tomorrow = new Date(zoned.getFullYear(), zoned.getMonth(), zoned.getDate() + 1)
        const year = tomorrow.getFullYear()
        const month = String(tomorrow.getMonth() + 1).padStart(2, '0')
        const day = String(tomorrow.getDate()).padStart(2, '0')
        targetDate = `${year}-${month}-${day}`
      }

      await ctx.vault.updateAccountData<FlockAccountFields>({
        account: input.account,
        snoozeRemindersUntil: targetDate,
      })

      return { success: true, snoozeRemindersUntil: targetDate }
    }),
})
