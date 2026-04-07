import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import getDriver from '../drivers'
import { appRouter } from '../trpc/root'
import { createContext } from '../trpc/trpc'
import { getAuthToken } from './util'
import {
  pullAutomergeSyncMessages,
  pushAutomergeSyncMessage,
} from '../services/automergeSyncService'


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

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  })

  server.post('/sync/push', async (request, reply) => {
    const body = request.body as {
      account?: unknown
      itemId?: unknown
      encryptedMessage?: { iv?: unknown; cipher?: unknown }
    }

    const account = typeof body?.account === 'string' ? body.account : ''
    const itemId = typeof body?.itemId === 'string' ? body.itemId : ''
    const iv = typeof body?.encryptedMessage?.iv === 'string' ? body.encryptedMessage.iv : ''
    const cipher = typeof body?.encryptedMessage?.cipher === 'string' ? body.encryptedMessage.cipher : ''

    if (!account || !itemId || !iv || !cipher) {
      return reply.status(400).send({ success: false, error: 'Invalid sync push payload' })
    }

    const session = getAuthToken(request)
    const valid = await vault.checkSession({ account, session }).catch(() => ({ success: false }))
    if (!valid.success) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' })
    }

    const result = await pushAutomergeSyncMessage({
      account,
      itemId,
      encryptedMessage: { iv, cipher },
    })

    return reply.send(result)
  })

  server.get('/sync/pull', async (request, reply) => {
    const query = request.query as {
      account?: unknown
      itemId?: unknown
      cursor?: unknown
    }

    const account = typeof query.account === 'string' ? query.account : ''
    const itemId = typeof query.itemId === 'string' ? query.itemId : ''
    const cursor = typeof query.cursor === 'string' ? Number(query.cursor) : 0

    if (!account || !itemId) {
      return reply.status(400).send({ success: false, error: 'Invalid sync pull query' })
    }

    const session = getAuthToken(request)
    const valid = await vault.checkSession({ account, session }).catch(() => ({ success: false }))
    if (!valid.success) {
      return reply.status(401).send({ success: false, error: 'Unauthorized' })
    }

    const result = await pullAutomergeSyncMessages({
      account,
      itemId,
      cursor: Number.isFinite(cursor) ? cursor : 0,
    })

    return reply.send(result)
  })

  server.get('/', async () => ({ ping: 'pong' }))

  return server
}

export default createServer
