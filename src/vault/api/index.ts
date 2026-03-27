import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import getDriver from '../drivers'
import { appRouter } from '../trpc/root'
import { createContext } from '../trpc/trpc'
import { getRealtimeEventsSince, subscribeToRealtimeEvents } from '../realtime/hub'


async function createServer() {
  const server = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
    },
  })
  await server.register(cookie)
  await server.register(cors, {
    origin: [
      /^https?:\/\/flock(-[^.]+)?\.cross-code\.org$/,
      /^https?:\/\/localhost(:[0-9]+)?$/,
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  })
  await server.register(fastifyAuth)

  const vault = getDriver('dynamo')
  server.decorate('vault', vault)
  const serverWithVault = server as typeof server & { vault: typeof vault }

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  })

  server.get<{
    Querystring: {
      account?: string
      token?: string
      lastEventId?: string
    }
  }>('/events', async (request, reply) => {
    const { account = '', token = '', lastEventId } = request.query
    if (!account || !token) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' })
    }

    const valid = await serverWithVault.vault.checkSession({ account, session: token }).catch(() => ({ success: false }))
    if (!valid.success) {
      return reply.code(401).send({ success: false, error: 'Unauthorized' })
    }

    const parsedLastEventId = Number.parseInt(
      lastEventId || String(request.headers['last-event-id'] || ''),
      10,
    )
    const replayFrom = Number.isFinite(parsedLastEventId) ? parsedLastEventId : 0

    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const writeEvent = (eventName: string, payload: unknown, eventId?: number) => {
      if (eventId) {
        reply.raw.write(`id: ${eventId}\n`)
      }
      reply.raw.write(`event: ${eventName}\n`)
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`)
    }

    const replayEvents = getRealtimeEventsSince(account, replayFrom)
    for (const event of replayEvents) {
      writeEvent(event.eventType, event, event.eventId)
    }

    const unsubscribe = subscribeToRealtimeEvents(account, event => {
      writeEvent(event.eventType, event, event.eventId)
    })

    const heartbeatTimer = setInterval(() => {
      writeEvent('heartbeat', { ts: Date.now() })
    }, 15000)

    let closed = false
    const cleanup = () => {
      if (closed) {
        return
      }
      closed = true
      clearInterval(heartbeatTimer)
      unsubscribe()
      reply.raw.end()
    }

    request.raw.on('close', cleanup)
  })

  server.get('/', async () => ({ ping: 'pong' }))

  return server
}

export default createServer
