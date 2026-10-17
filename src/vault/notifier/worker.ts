import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
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

export async function processMessage({ accountId, subscription, topic }: ReminderMessage) {
  try {
    await sendPushNotification(subscription, REMINDER_PAYLOAD, { topic })
  } catch (error) {
    const statusCode = (error as { statusCode?: number }).statusCode
    if (statusCode !== 404 && statusCode !== 410) {
      throw error
    }
    await removeSubscription(accountId, subscription.endpoint)
  }
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
      console.error(`Failed to process push notification message ${record.messageId}`, error)
      batchItemFailures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures }
}