import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { WebPushSubscription } from '../types'
import { getConnectionParams } from '@vault/server/dynamo'
import { FLOCK_TABLES } from '../flockDriver'
import { sendPushNotification } from './webpush'

type ReminderMessage = {
  accountId: string,
  pushSubscriptions: WebPushSubscription[],
}

type SqsRecord = {
  body: string,
}

type SqsEvent = {
  Records: SqsRecord[],
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

export async function processMessage(message: ReminderMessage) {
  const payload = {
    title: 'Prayer reminder',
    body: 'Time to pray for your flock.',
    url: '/',
    icon: '/android-chrome-192x192.png',
    badge: '/badge-96x96.png',
  }

  for (const subscription of message.pushSubscriptions) {
    try {
      await sendPushNotification(subscription, payload)
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode
      if (statusCode === 404 || statusCode === 410) {
        await removeSubscription(message.accountId, subscription.endpoint)
        continue
      }

      throw error
    }
  }
}

export const handler = async (event: SqsEvent) => {
  for (const record of event.Records) {
    const message = JSON.parse(record.body) as ReminderMessage
    await processMessage(message)
  }
}