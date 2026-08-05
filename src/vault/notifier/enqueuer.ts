import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  SendMessageBatchCommand,
  SQSClient,
} from '@aws-sdk/client-sqs'
import {
  DynamoDBDocumentClient,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  toZonedTime,
} from 'date-fns-tz'
import type { WebPushSubscription } from '../types'
import {
  ACCOUNT_TABLE_NAME,
  getConnectionParams,
} from '../drivers/dynamo'

type ReminderAccount = {
  account: string,
  pushSubscriptions?: WebPushSubscription[],
  reminderEnabled?: boolean,
  reminderTime?: string,
  reminderTimezone?: string,
}

type QueuePayload = {
  accountId: string,
  pushSubscriptions: WebPushSubscription[],
}

const ddb = new DynamoDBClient(getConnectionParams())
const docClient = DynamoDBDocumentClient.from(ddb)
const sqs = new SQSClient({})

const utcToZonedTime = toZonedTime

export function isReminderTimeMatch(nowUtc: Date, reminderTime: string, timezone: string): boolean {
  try {
    const [targetHourStr, targetMinuteStr] = reminderTime.split(':')
    const targetHour = Number(targetHourStr)
    const targetMinute = Number(targetMinuteStr)

    if (Number.isNaN(targetHour) || Number.isNaN(targetMinute)) {
      return false
    }

    const targetMinutes = targetHour * 60 + targetMinute
    const zoned = utcToZonedTime(nowUtc, timezone)
    const localMinutesNow = zoned.getHours() * 60 + zoned.getMinutes()

    const diffMinutes = ((localMinutesNow - targetMinutes) % 1440 + 1440) % 1440
    return diffMinutes >= 0 && diffMinutes < 15
  } catch {
    return false
  }
}

function toQueueEntries(payloads: QueuePayload[], startIndex: number) {
  return payloads.map((payload, offset) => ({
    Id: String(startIndex + offset),
    MessageBody: JSON.stringify(payload),
  }))
}

async function getEnabledReminderAccounts() {
  const accounts: ReminderAccount[] = []
  let lastEvaluatedKey: Record<string, unknown> | undefined

  do {
    const response = await docClient.send(new ScanCommand({
      TableName: ACCOUNT_TABLE_NAME,
      ExclusiveStartKey: lastEvaluatedKey,
      FilterExpression: 'reminderEnabled = :enabled',
      ExpressionAttributeValues: {
        ':enabled': true,
      },
      ProjectionExpression: 'account, pushSubscriptions, reminderEnabled, reminderTime, reminderTimezone',
    }))

    if (response.Items) {
      accounts.push(...(response.Items as ReminderAccount[]))
    }

    lastEvaluatedKey = response.LastEvaluatedKey as Record<string, unknown> | undefined
  } while (lastEvaluatedKey)

  return accounts
}

export const handler = async () => {
  const queueUrl = process.env.PUSH_NOTIFICATIONS_QUEUE_URL
  if (!queueUrl) {
    throw new Error('Missing PUSH_NOTIFICATIONS_QUEUE_URL')
  }

  const nowUtc = new Date()
  const accounts = await getEnabledReminderAccounts()

  const payloads: QueuePayload[] = accounts
    .map(account => {
      const reminderTime = account.reminderTime ?? '08:00'
      const timezone = account.reminderTimezone ?? 'UTC'
      const subscriptions = account.pushSubscriptions ?? []

      if (subscriptions.length === 0) {
        return null
      }

      if (!isReminderTimeMatch(nowUtc, reminderTime, timezone)) {
        return null
      }

      return {
        accountId: account.account,
        pushSubscriptions: subscriptions,
      }
    })
    .filter((payload): payload is QueuePayload => payload !== null)

  for (let i = 0; i < payloads.length; i += 10) {
    const batch = payloads.slice(i, i + 10)
    if (batch.length === 0) {
      continue
    }

    const response = await sqs.send(new SendMessageBatchCommand({
      QueueUrl: queueUrl,
      Entries: toQueueEntries(batch, i),
    }))

    if ((response.Failed?.length ?? 0) > 0) {
      const details = response.Failed?.map(entry => `${entry.Id}:${entry.Message}`).join(', ')
      throw new Error(`Failed to enqueue reminder batch: ${details}`)
    }
  }
}