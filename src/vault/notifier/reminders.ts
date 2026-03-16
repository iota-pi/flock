import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { WebPushSubscription } from '../../shared/apiTypes'
import { isSameDay } from '../../utils'
import { sendPushNotifications } from '.'
import {
  ACCOUNT_TABLE_NAME,
  ITEM_TABLE_NAME,
  getConnectionParams,
} from '../drivers/dynamo'

type ReminderAccount = {
  account: string,
  lastPrayerCompletedAt?: number,
  metadata?: Record<string, unknown>,
  pushSubscriptions?: WebPushSubscription[],
  reminderEnabled?: boolean,
  reminderTime?: string,
  reminderTimezone?: string,
}

const ddb = new DynamoDBClient(getConnectionParams())
const client = DynamoDBDocumentClient.from(ddb)

function getLocalHourMinute(now: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).formatToParts(now)

  const hour = Number(parts.find(part => part.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find(part => part.type === 'minute')?.value ?? '0')
  return { hour, minute }
}

function parseReminderTime(reminderTime: string) {
  const [hourStr, minuteStr] = reminderTime.split(':')
  const hour = Number(hourStr)
  const minute = Number(minuteStr)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }
  return { hour, minute }
}

function isInCurrentExecutionWindow(now: Date, reminderTime: string, timezone: string) {
  const parsedReminder = parseReminderTime(reminderTime)
  if (!parsedReminder) {
    return false
  }

  try {
    const local = getLocalHourMinute(now, timezone)
    const nowMinutes = local.hour * 60 + local.minute
    const reminderMinutes = parsedReminder.hour * 60 + parsedReminder.minute
    return nowMinutes >= reminderMinutes && nowMinutes < reminderMinutes + 15
  } catch {
    return false
  }
}

async function getEnabledReminderAccounts() {
  const accounts: ReminderAccount[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const response = await client.send(new ScanCommand({
      TableName: ACCOUNT_TABLE_NAME,
      ExclusiveStartKey: lastEvaluatedKey,
      FilterExpression: 'reminderEnabled = :enabled',
      ExpressionAttributeValues: {
        ':enabled': true,
      },
      ProjectionExpression: (
        'account, lastPrayerCompletedAt, metadata, pushSubscriptions, reminderEnabled, reminderTime, reminderTimezone'
      ),
    }))

    if (response.Items) {
      accounts.push(...response.Items as ReminderAccount[])
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  return accounts
}

async function getAccountItemsCount(account: string) {
  let count = 0
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const response = await client.send(new QueryCommand({
      TableName: ITEM_TABLE_NAME,
      KeyConditionExpression: 'account = :account',
      ExpressionAttributeValues: {
        ':account': account,
      },
      ProjectionExpression: '#itemKey',
      ExpressionAttributeNames: {
        '#itemKey': 'item',
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Select: 'COUNT',
    }))

    count += response.Count ?? 0
    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  return count
}

function hasCompletedPrayerToday(account: ReminderAccount, now: Date) {
  const metadata = account.metadata ?? {}
  const completionTimestamp = account.lastPrayerCompletedAt ?? metadata.lastPrayerCompletedAt ?? metadata.lastPrayedAt
  if (typeof completionTimestamp !== 'number') {
    return false
  }
  return isSameDay(now, new Date(completionTimestamp))
}

async function removeFailedSubscriptions(account: string, failedEndpoints: string[]) {
  if (failedEndpoints.length === 0) {
    return
  }

  const accountResponse = await client.send(new GetCommand({
    TableName: ACCOUNT_TABLE_NAME,
    Key: { account },
    ProjectionExpression: 'account, pushSubscriptions',
  }))

  const current = accountResponse.Item as ReminderAccount | undefined
  if (!current?.pushSubscriptions) {
    return
  }

  const failed = new Set(failedEndpoints)
  const nextSubscriptions = current.pushSubscriptions.filter(sub => !failed.has(sub.endpoint))

  await client.send(new UpdateCommand({
    TableName: ACCOUNT_TABLE_NAME,
    Key: { account },
    UpdateExpression: 'SET pushSubscriptions = :pushSubscriptions',
    ExpressionAttributeValues: {
      ':pushSubscriptions': nextSubscriptions,
    },
  }))
}

export const handler = async () => {
  const now = new Date()
  const accounts = await getEnabledReminderAccounts()

  for (const account of accounts) {
    const reminderTime = account.reminderTime ?? '08:00'
    const timezone = account.reminderTimezone ?? 'UTC'

    if (!isInCurrentExecutionWindow(now, reminderTime, timezone)) {
      continue
    }

    const itemCount = await getAccountItemsCount(account.account)
    if (itemCount === 0) {
      continue
    }

    if (hasCompletedPrayerToday(account, now)) {
      continue
    }

    const subscriptions = account.pushSubscriptions ?? []
    if (subscriptions.length === 0) {
      continue
    }

    const { failedEndpoints } = await sendPushNotifications(
      subscriptions,
      {
        title: 'Prayer reminder',
        body: 'Time to pray for your flock.',
      },
    )

    if (failedEndpoints.length > 0) {
      await removeFailedSubscriptions(account.account, failedEndpoints)
    }
  }
}
