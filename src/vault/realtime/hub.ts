import type { RealtimeEventEnvelope, RealtimeEventType } from '../../shared/realtime'
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  ApiGatewayManagementApiClient,
  GoneException,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi'

const REPLAY_TTL_SECONDS = Number(process.env.REALTIME_REPLAY_TTL_SECONDS || 3600)
const CONNECTION_TTL_SECONDS = Number(process.env.REALTIME_CONNECTION_TTL_SECONDS || 2 * 60 * 60)
const MAX_REPLAY_EVENTS = Number(process.env.REALTIME_MAX_REPLAY_EVENTS || 500)

const REALTIME_EVENTS_TABLE = process.env.REALTIME_REPLAY_LOG_TABLE || process.env.REALTIME_EVENTS_TABLE || 'FlockReplayLog'
const REALTIME_CONNECTIONS_TABLE = process.env.REALTIME_CONNECTIONS_TABLE || 'FlockConnections'
const CONNECTIONS_ACCOUNT_INDEX = process.env.REALTIME_CONNECTIONS_ACCOUNT_GSI || 'AccountIndex'
const API_GATEWAY_MANAGEMENT_ENDPOINT = process.env.API_GATEWAY_MANAGEMENT_ENDPOINT || ''
const AWS_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2'
const DISABLE_WS_PUSH = process.env.REALTIME_DISABLE_WS_PUSH === '1'

const ddbClient = new DynamoDBClient({ region: AWS_REGION })
const docClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: { removeUndefinedValues: true },
})

const inMemoryReplayLog = new Map<string, RealtimeEventEnvelope[]>()
const inMemoryCounters = new Map<string, number>()
const inMemoryConnections = new Map<string, Set<string>>()

type SyncPingPayload = {
  action: 'sync_ping'
  itemIds: string[]
}

type DirectSyncPushPayload = {
  action: 'direct_sync_push'
  itemId: string
  encryptedMessage: { iv: string; cipher: string }
  cursor: number
}
async function getNextEventId(account: string): Promise<number> {
  const counterKey = {
    account,
    eventId: 0,
  }

  const result = await docClient.send(new UpdateCommand({
    TableName: REALTIME_EVENTS_TABLE,
    Key: counterKey,
    UpdateExpression: 'ADD #seq :inc SET #expiresAt = :expiresAt',
    ExpressionAttributeNames: {
      '#seq': 'seq',
      '#expiresAt': 'expiresAt',
    },
    ExpressionAttributeValues: {
      ':inc': 1,
      ':expiresAt': Math.floor(Date.now() / 1000) + REPLAY_TTL_SECONDS,
    },
    ReturnValues: 'UPDATED_NEW',
  })).catch(() => null)

  if (result?.Attributes?.seq) {
    return Number(result.Attributes.seq)
  }

  const current = inMemoryCounters.get(account) || 0
  const next = current + 1
  inMemoryCounters.set(account, next)
  return next
}

function getReplayExpirySeconds(): number {
  return Math.floor(Date.now() / 1000) + REPLAY_TTL_SECONDS
}

function getConnectionExpirySeconds(): number {
  return Math.floor(Date.now() / 1000) + CONNECTION_TTL_SECONDS
}

function getManagementEndpoint(connection: {
  managementEndpoint?: string
  domainName?: string
  stage?: string
}): string {
  if (connection.managementEndpoint) {
    return connection.managementEndpoint
  }

  if (connection.domainName && connection.stage) {
    return `https://${connection.domainName}/${connection.stage}`
  }

  return API_GATEWAY_MANAGEMENT_ENDPOINT
}

async function removeConnection(account: string, connectionId: string): Promise<void> {
  await docClient.send(new DeleteCommand({
    TableName: REALTIME_CONNECTIONS_TABLE,
    Key: {
      connectionId,
    },
  })).catch(() => {})

  const existing = inMemoryConnections.get(account)
  if (existing) {
    existing.delete(connectionId)
    if (existing.size === 0) {
      inMemoryConnections.delete(account)
    }
  }
}

async function broadcastPayloadToApiGatewayConnections(account: string, payload: unknown): Promise<void> {
  if (DISABLE_WS_PUSH) {
    return
  }

  const connections = await docClient.send(new QueryCommand({
    TableName: REALTIME_CONNECTIONS_TABLE,
    IndexName: CONNECTIONS_ACCOUNT_INDEX,
    KeyConditionExpression: '#account = :account',
    ExpressionAttributeNames: {
      '#account': 'account',
    },
    ExpressionAttributeValues: {
      ':account': account,
    },
  })).catch(() => ({ Items: [] as Record<string, unknown>[] }))

  for (const connection of connections.Items || []) {
    const connectionId = String(connection.connectionId || '')
    if (!connectionId) {
      continue
    }

    const endpoint = getManagementEndpoint(connection)
    if (!endpoint) {
      continue
    }

    const client = new ApiGatewayManagementApiClient({
      endpoint,
      region: AWS_REGION,
    })

    try {
      await client.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload), 'utf8'),
      }))
    } catch (error) {
      if (error instanceof GoneException) {
        await removeConnection(account, connectionId)
      }
    }
  }

  const fallbackConnections = inMemoryConnections.get(account)
  if (fallbackConnections && fallbackConnections.size > 0) {
    // No-op: local fallback only tracks membership for tests/dev without WS infra.
  }
}

async function broadcastToApiGatewayConnections(event: RealtimeEventEnvelope): Promise<void> {
  await broadcastPayloadToApiGatewayConnections(event.account, event)
}

async function postEventToConnection(
  event: RealtimeEventEnvelope,
  connectionId: string,
  endpoint: string,
): Promise<void> {
  if (!connectionId || !endpoint) {
    return
  }

  const client = new ApiGatewayManagementApiClient({
    endpoint,
    region: AWS_REGION,
  })

  await client.send(new PostToConnectionCommand({
    ConnectionId: connectionId,
    Data: Buffer.from(JSON.stringify(event), 'utf8'),
  }))
}

export async function registerRealtimeConnection(params: {
  account: string
  connectionId: string
  managementEndpoint?: string
  domainName?: string
  stage?: string
}): Promise<void> {
  await docClient.send(new PutCommand({
    TableName: REALTIME_CONNECTIONS_TABLE,
    Item: {
      connectionId: params.connectionId,
      account: params.account,
      managementEndpoint: params.managementEndpoint,
      domainName: params.domainName,
      stage: params.stage,
      createdAt: Date.now(),
      expiresAt: getConnectionExpirySeconds(),
    },
  })).catch(() => {})

  const existing = inMemoryConnections.get(params.account) || new Set<string>()
  existing.add(params.connectionId)
  inMemoryConnections.set(params.account, existing)
}

export async function touchRealtimeConnection(connectionId: string): Promise<void> {
  if (!connectionId) {
    return
  }

  await docClient.send(new UpdateCommand({
    TableName: REALTIME_CONNECTIONS_TABLE,
    Key: {
      connectionId,
    },
    UpdateExpression: 'SET #expiresAt = :expiresAt',
    ExpressionAttributeNames: {
      '#expiresAt': 'expiresAt',
    },
    ExpressionAttributeValues: {
      ':expiresAt': getConnectionExpirySeconds(),
    },
  })).catch(() => {})
}

export async function unregisterRealtimeConnection(params: {
  account?: string
  connectionId: string
}): Promise<void> {
  if (params.account) {
    await removeConnection(params.account, params.connectionId)
    return
  }

  const connection = await docClient.send(new QueryCommand({
    TableName: REALTIME_CONNECTIONS_TABLE,
    KeyConditionExpression: '#connectionId = :connectionId',
    ExpressionAttributeNames: {
      '#connectionId': 'connectionId',
    },
    ExpressionAttributeValues: {
      ':connectionId': params.connectionId,
    },
    Limit: 1,
  })).catch(() => null)

  const account = String(connection?.Items?.[0]?.account || '')
  if (account) {
    await removeConnection(account, params.connectionId)
  }
}

export async function publishRealtimeEvent<T>(
  account: string,
  eventType: RealtimeEventType,
  data: T,
): Promise<RealtimeEventEnvelope<T>> {
  const eventId = await getNextEventId(account)

  const event: RealtimeEventEnvelope<T> = {
    eventId,
    eventType,
    account,
    createdAt: Date.now(),
    data,
  }

  await docClient.send(new PutCommand({
    TableName: REALTIME_EVENTS_TABLE,
    Item: {
      ...event,
      expiresAt: getReplayExpirySeconds(),
    },
  })).catch(() => {
    const existing = inMemoryReplayLog.get(account) || []
    existing.push(event)
    if (existing.length > MAX_REPLAY_EVENTS) {
      existing.splice(0, existing.length - MAX_REPLAY_EVENTS)
    }
    inMemoryReplayLog.set(account, existing)
  })

  await broadcastToApiGatewayConnections(event)

  return event
}

export async function publishSyncPing(account: string, itemIds: string[]): Promise<void> {
  const payload: SyncPingPayload = {
    action: 'sync_ping',
    itemIds,
  }

  await broadcastPayloadToApiGatewayConnections(account, payload)
}

export async function publishDirectSyncPush(account: string, itemId: string, encryptedMessage: { iv: string; cipher: string }, cursor: number): Promise<void> {
  const payload: DirectSyncPushPayload = {
    action: 'direct_sync_push',
    itemId,
    encryptedMessage,
    cursor,
  }

  await broadcastPayloadToApiGatewayConnections(account, payload)
}

async function getRealtimeEventsSince(
  account: string,
  lastEventId?: number,
): Promise<RealtimeEventEnvelope[]> {
  const minEventId = lastEventId && lastEventId > 0 ? lastEventId : 0
  const result = await docClient.send(new QueryCommand({
    TableName: REALTIME_EVENTS_TABLE,
    KeyConditionExpression: '#account = :account AND #eventId > :lastEventId',
    ExpressionAttributeNames: {
      '#account': 'account',
      '#eventId': 'eventId',
    },
    ExpressionAttributeValues: {
      ':account': account,
      ':lastEventId': minEventId,
    },
    ScanIndexForward: true,
    Limit: MAX_REPLAY_EVENTS,
  })).catch(() => null)

  if (!result) {
    const existing = inMemoryReplayLog.get(account) || []
    return existing.filter(event => event.eventId > minEventId)
  }

  return (result.Items || [])
    .filter(item => Number(item.eventId) > 0)
    .map(item => ({
      eventId: Number(item.eventId),
      eventType: item.eventType as RealtimeEventType,
      account: String(item.account),
      createdAt: Number(item.createdAt),
      data: item.data,
    }))
}

export async function replayEventsToConnection(params: {
  account: string
  connectionId: string
  endpoint: string
  lastEventId?: number
}): Promise<void> {
  const events = await getRealtimeEventsSince(params.account, params.lastEventId)
  for (const event of events) {
    await postEventToConnection(event, params.connectionId, params.endpoint).catch(async error => {
      if (error instanceof GoneException) {
        await removeConnection(params.account, params.connectionId)
      }
    })
  }
}
