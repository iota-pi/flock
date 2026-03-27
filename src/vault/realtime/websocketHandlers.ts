import {
  registerRealtimeConnection,
  unregisterRealtimeConnection,
  replayEventsToConnection,
} from './hub'
import getDriver from '../drivers'

type WebsocketEvent = {
  headers?: Record<string, string | undefined>
  queryStringParameters?: Record<string, string | undefined>
  requestContext: {
    connectionId?: string
    domainName?: string
    stage?: string
  }
}

function getConnectAuth(event: WebsocketEvent): {
  account: string
  session: string
  lastEventId: number
} {
  const account = event.queryStringParameters?.account || ''
  const session = event.queryStringParameters?.token || ''
  const lastEventId = Number(event.queryStringParameters?.lastEventId || 0)

  return { account, session, lastEventId: Number.isFinite(lastEventId) ? lastEventId : 0 }
}

export async function websocketConnectHandler(event: WebsocketEvent) {
  const { account, session, lastEventId } = getConnectAuth(event)
  const connectionId = event.requestContext.connectionId || ''

  if (!account || !session || !connectionId) {
    return { statusCode: 401, body: 'Unauthorized' }
  }

  const vault = getDriver('dynamo')
  const valid = await vault.checkSession({ account, session }).catch(() => ({ success: false }))
  if (!valid.success) {
    return { statusCode: 401, body: 'Unauthorized' }
  }

  await registerRealtimeConnection({
    account,
    connectionId,
    domainName: event.requestContext.domainName,
    stage: event.requestContext.stage,
  })

  const endpoint = event.requestContext.domainName && event.requestContext.stage
    ? `https://${event.requestContext.domainName}/${event.requestContext.stage}`
    : ''

  if (endpoint) {
    await replayEventsToConnection({
      account,
      connectionId,
      endpoint,
      lastEventId,
    })
  }

  return { statusCode: 200, body: 'Connected' }
}

export async function websocketDisconnectHandler(event: WebsocketEvent) {
  const connectionId = event.requestContext.connectionId || ''
  const account = event.queryStringParameters?.account || ''

  if (!connectionId) {
    return { statusCode: 200, body: 'No connection id' }
  }

  if (account) {
    await unregisterRealtimeConnection({
      account,
      connectionId,
    })
  } else {
    await unregisterRealtimeConnection({ connectionId })
  }

  return { statusCode: 200, body: 'Disconnected' }
}

export async function websocketDefaultHandler() {
  return { statusCode: 200, body: 'OK' }
}
