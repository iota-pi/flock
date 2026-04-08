import type { WebPushSubscription } from '../../vault/types'
import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import { assertSuccess } from './clientUtils'
import type { ReminderSettingsResponse } from './clientTypes'

export async function addPushSubscription(subscription: WebPushSubscription): Promise<void> {
  const response = await trpcClient.accounts.addPushSubscription.mutate({
    account: getAccountId(),
    endpoint: subscription.endpoint,
    keys: subscription.keys,
  })
  assertSuccess(response, 'addPushSubscription')
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  const response = await trpcClient.accounts.deletePushSubscription.mutate({
    account: getAccountId(),
    endpoint,
  })
  assertSuccess(response, 'deletePushSubscription')
}

export async function getReminderSettings(): Promise<ReminderSettingsResponse> {
  const response = await trpcClient.accounts.getReminderSettings.query({ account: getAccountId() })
  assertSuccess(response, 'getReminderSettings')
  return response
}

export async function updateReminderSettings(
  settings: { reminderEnabled: boolean; reminderTime: string; reminderTimezone: string },
): Promise<void> {
  const response = await trpcClient.accounts.updateReminderSettings.mutate({
    account: getAccountId(),
    ...settings,
  })
  assertSuccess(response, 'updateReminderSettings')
}