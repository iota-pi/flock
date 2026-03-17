import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { WebPushSubscription } from '../../shared/apiTypes'
import {
  ACCOUNT_TABLE_NAME,
  getConnectionParams,
} from '../drivers/dynamo'
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

async function removeSubscription(accountId: string, endpoint: string) {
  const accountResponse = await docClient.send(new GetCommand({
    TableName: ACCOUNT_TABLE_NAME,
    Key: { account: accountId },
    ProjectionExpression: 'account, pushSubscriptions',
  }))

  const account = accountResponse.Item as { pushSubscriptions?: WebPushSubscription[] } | undefined
  const currentSubscriptions = account?.pushSubscriptions ?? []
  const nextSubscriptions = currentSubscriptions.filter(sub => sub.endpoint !== endpoint)

  await docClient.send(new UpdateCommand({
    TableName: ACCOUNT_TABLE_NAME,
    Key: { account: accountId },
    UpdateExpression: 'SET pushSubscriptions = :pushSubscriptions',
    ExpressionAttributeValues: {
      ':pushSubscriptions': nextSubscriptions,
    },
  }))
}

async function processMessage(message: ReminderMessage) {
  const payload = {
    title: 'Prayer reminder',
    body: 'Time to pray for your flock.',
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