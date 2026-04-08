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

async function appendSyncMessage(input: {
  account: string
  itemId: string
  encryptedMessage: {
    iv: string
    cipher: string
  }
}): Promise<number> {
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

  return cursor
}

export async function pushAutomergeSyncMessage(input: {
  account: string
  itemId: string
  encryptedMessage: {
    iv: string
    cipher: string
  }
}): Promise<{ success: true; cursor: number }> {
  const cursor = await appendSyncMessage(input)

  await publishSyncPing(input.account, [input.itemId])

  return {
    success: true,
    cursor,
  }
}

export async function pushAutomergeSyncBatch(input: {
  account: string
  messages: Array<{
    itemId: string
    encryptedMessage: {
      iv: string
      cipher: string
    }
  }>
}): Promise<{ success: true; results: Array<{ itemId: string; cursor: number }> }> {
  const results: Array<{ itemId: string; cursor: number }> = []

  for (const message of input.messages) {
    const cursor = await appendSyncMessage({
      account: input.account,
      itemId: message.itemId,
      encryptedMessage: message.encryptedMessage,
    })
    results.push({ itemId: message.itemId, cursor })
  }

  const uniqueItemIds = Array.from(new Set(input.messages.map(message => message.itemId)))
  if (uniqueItemIds.length > 0) {
    await publishSyncPing(input.account, uniqueItemIds)
  }

  return {
    success: true,
    results,
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

export async function pullAutomergeSyncBatch(input: {
  account: string
  cursors: Array<{
    itemId: string
    cursor?: number
  }>
}): Promise<{
  success: true
  results: Array<{
    success: true
    itemId: string
    nextCursor: number
    messages: StoredSyncMessage[]
  }>
}> {
  const dedupedCursorsByItemId = new Map<string, number>()
  for (const cursorInput of input.cursors) {
    const existing = dedupedCursorsByItemId.get(cursorInput.itemId) || 0
    const next = typeof cursorInput.cursor === 'number' ? cursorInput.cursor : 0
    dedupedCursorsByItemId.set(cursorInput.itemId, Math.max(existing, next))
  }

  const results: Array<{
    success: true
    itemId: string
    nextCursor: number
    messages: StoredSyncMessage[]
  }> = []

  for (const [itemId, cursor] of dedupedCursorsByItemId.entries()) {
    const pulled = await pullAutomergeSyncMessages({
      account: input.account,
      itemId,
      cursor,
    })
    results.push(pulled)
  }

  return {
    success: true,
    results,
  }
}
