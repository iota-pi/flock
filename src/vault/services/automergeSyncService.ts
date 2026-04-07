import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import { publishSyncPing } from '../realtime/hub'

const ITEMS_TABLE = process.env.ITEMS_TABLE || 'FlockItems'
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2'

type StoredSyncMessage = {
  cursor: number
  encryptedMessage: {
    iv: string
    cipher: string
  }
  createdAt: number
}

const ddbClient = new DynamoDBClient({ region: AWS_REGION })
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
})

function createCursor(): number {
  return Number(`${Date.now()}${Math.floor(Math.random() * 1000).toString().padStart(3, '0')}`)
}

export async function pushAutomergeSyncMessage(input: {
  account: string
  itemId: string
  encryptedMessage: {
    iv: string
    cipher: string
  }
}): Promise<{ success: true; cursor: number }> {
  const now = Date.now()
  const cursor = createCursor()
  const entry: StoredSyncMessage = {
    cursor,
    encryptedMessage: input.encryptedMessage,
    createdAt: now,
  }

  await docClient.send(new UpdateCommand({
    TableName: ITEMS_TABLE,
    Key: {
      account: input.account,
      item: input.itemId,
    },
    UpdateExpression: 'SET #syncMessages = list_append(if_not_exists(#syncMessages, :empty), :newEntries), #lastModified = :lastModified',
    ExpressionAttributeNames: {
      '#syncMessages': 'syncMessages',
      '#lastModified': 'syncLastModified',
    },
    ExpressionAttributeValues: {
      ':empty': [],
      ':newEntries': [entry],
      ':lastModified': now,
    },
  }))

  await publishSyncPing(input.account, [input.itemId])

  return {
    success: true,
    cursor,
  }
}

export async function pullAutomergeSyncMessages(input: {
  account: string
  itemId: string
  cursor?: number
}): Promise<{
  success: true
  itemId: string
  nextCursor: number
  messages: StoredSyncMessage[]
}> {
  const fromCursor = typeof input.cursor === 'number' ? input.cursor : 0

  const response = await docClient.send(new GetCommand({
    TableName: ITEMS_TABLE,
    Key: {
      account: input.account,
      item: input.itemId,
    },
  }))

  const storedMessages = Array.isArray(response.Item?.syncMessages)
    ? response.Item?.syncMessages as StoredSyncMessage[]
    : []

  const messages = storedMessages
    .filter(message => typeof message.cursor === 'number' && message.cursor > fromCursor)
    .sort((left, right) => left.cursor - right.cursor)

  const nextCursor = messages.length > 0
    ? messages[messages.length - 1].cursor
    : fromCursor

  return {
    success: true,
    itemId: input.itemId,
    nextCursor,
    messages,
  }
}
