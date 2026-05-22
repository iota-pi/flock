import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import getDriver from '../drivers'
import { appRouter } from '../trpc/root'
import { createContext } from '../trpc/trpc'


async function createServer(devMode = false) {
  const server = Fastify({
    logger: {
      level: devMode ? 'info' : 'warn',
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

  const vault = getDriver('dynamo', devMode)
  server.decorate('vault', vault)

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext,
    },
  })

  server.get('/', async () => ({ ping: 'pong' }))

  return server
}

export default createServer
