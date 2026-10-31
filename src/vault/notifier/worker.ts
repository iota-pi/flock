import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { WebPushError } from 'web-push'
import type { WebPushSubscription } from '../types'
import { getConnectionParams } from '@vault/server/dynamo'
import { FLOCK_TABLES } from '../flockDriver'
import type { ReminderMessage } from './messages'
import { sendPushNotification } from './webpush'

type SqsRecord = {
  messageId: string,
  body: string,
}

type SqsEvent = {
  Records: SqsRecord[],
}

type SqsBatchResponse = {
  batchItemFailures: Array<{ itemIdentifier: string }>,
}

const ddb = new DynamoDBClient(getConnectionParams())
const docClient = DynamoDBDocumentClient.from(ddb)

export async function removeSubscription(accountId: string, endpoint: string) {
  const accountResponse = await docClient.send(new GetCommand({
    TableName: FLOCK_TABLES.accounts,
    Key: { account: accountId },
    ProjectionExpression: 'account, pushSubscriptions',
  }))

  const account = accountResponse.Item as { pushSubscriptions?: WebPushSubscription[] } | undefined
  const currentSubscriptions = account?.pushSubscriptions ?? []
  const nextSubscriptions = currentSubscriptions.filter(sub => sub.endpoint !== endpoint)

  await docClient.send(new UpdateCommand({
    TableName: FLOCK_TABLES.accounts,
    Key: { account: accountId },
    UpdateExpression: 'SET pushSubscriptions = :pushSubscriptions',
    ExpressionAttributeValues: {
      ':pushSubscriptions': nextSubscriptions,
    },
  }))
}

const REMINDER_PAYLOAD = {
  title: 'Prayer reminder',
  body: 'Time to pray for your flock.',
  url: '/',
  icon: '/android-chrome-192x192.png',
  badge: '/badge-96x96.png',
}

/** What FCM answers (403) for a subscription the browser made with a different VAPID key */
const VAPID_MISMATCH_BODY = 'do not correspond to the credentials used to create the subscriptions'

/**
 * Whether the subscription can never be sent to again: it expired or was revoked (404/410), or it
 * was made with another VAPID key, which would otherwise be retried every day forever
 */
function isSubscriptionGone(error: unknown) {
  const { statusCode, body } = error as { statusCode?: number, body?: unknown }
  if (statusCode === 404 || statusCode === 410) {
    return true
  }
  return statusCode === 403 && typeof body === 'string' && body.includes(VAPID_MISMATCH_BODY)
}

export async function processMessage({ accountId, subscription, topic }: ReminderMessage) {
  try {
    await sendPushNotification(subscription, REMINDER_PAYLOAD, { topic })
  } catch (error) {
    if (!isSubscriptionGone(error)) {
      throw error
    }
    await removeSubscription(accountId, subscription.endpoint)
  }
}

/**
 * A push error carries the subscription's endpoint, which identifies the user's device, so only
 * the parts that explain the failure are logged
 */
function describeError(error: unknown) {
  if (error instanceof WebPushError) {
    return { name: error.name, message: error.message, statusCode: error.statusCode, body: error.body }
  }
  return error
}

/**
 * Reports the records that failed, so SQS retries only those rather than the whole batch (which
 * would send duplicate reminders to the subscriptions that were already notified).
 */
export const handler = async (event: SqsEvent): Promise<SqsBatchResponse> => {
  const batchItemFailures: SqsBatchResponse['batchItemFailures'] = []
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body) as ReminderMessage
      await processMessage(message)
    } catch (error) {
      console.error(`Failed to process push notification message ${record.messageId}`, describeError(error))
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures }
}