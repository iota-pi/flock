import type { WebPushSubscription } from '../../vault/types'
import { getTrpcClient } from '../trpcClient'
import { assertSuccess } from './clientUtils'
import type { ReminderSettingsResponse } from './clientTypes'

export async function addPushSubscription(account: string, subscription: WebPushSubscription): Promise<void> {
  const response = await getTrpcClient().accounts.addPushSubscription.mutate({
    account,
    endpoint: subscription.endpoint,
    keys: subscription.keys,
  })
  assertSuccess(response, 'addPushSubscription')
}

export async function deletePushSubscription(account: string, endpoint: string): Promise<void> {
  const response = await getTrpcClient().accounts.deletePushSubscription.mutate({
    account,
    endpoint,
  })
  assertSuccess(response, 'deletePushSubscription')
}

export async function getReminderSettings(account: string): Promise<ReminderSettingsResponse> {
  const response = await getTrpcClient().accounts.getReminderSettings.query({ account })
  assertSuccess(response, 'getReminderSettings')
  return response
}

export async function updateReminderSettings(
  account: string,
  settings: { reminderEnabled: boolean; reminderTime: string; reminderTimezone: string },
): Promise<void> {
  const response = await getTrpcClient().accounts.updateReminderSettings.mutate({
    account,
    ...settings,
  })
  assertSuccess(response, 'updateReminderSettings')
}