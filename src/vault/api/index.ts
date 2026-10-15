import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import * as Sentry from '@sentry/node'
import { TRPCError } from '@trpc/server'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { createFlockDriver } from '../flockDriver'
import { flockDataVersionPolicy } from '../flockDataVersion'
import { appRouter } from '../trpc/root'
import { createVaultContext } from '@vault/server'
import { PROTOCOL_VERSION_HEADER } from '@vault/shared'

/**
 * Writes from builds below this protocol version are rejected, which makes them update. Raising it
 * retires the server code kept only for older builds (see docs/vault-extraction.md).
 */
const MIN_PROTOCOL_VERSION = 0


async function createServer(devMode = false) {
  const server = Fastify({
    logger: {
      level: devMode ? 'info' : 'warn',
    },
    // Allow large payloads for sync operations (especially for initial sync of index documents)
    bodyLimit: 50 * 1024 * 1024,
  })
  await server.register(cookie)
  await server.register(cors, {
    origin: [
      /^https?:\/\/flock(-[^.]+)?\.cross-code\.org$/,
      /^https?:\/\/localhost(:[0-9]+)?$/,
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', PROTOCOL_VERSION_HEADER],
    credentials: true,
  })

  const vault = createFlockDriver(devMode)
  server.decorate('vault', vault)

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      createContext: createVaultContext({
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        dataVersionPolicy: flockDataVersionPolicy,
      }),
      onError: ({ path, error }: { path: string | undefined, error: unknown }) => {
        console.error(`[TRPC Error] path=${path}:`, error)
        if (process.env.SENTRY_DSN) {
          const isExpectedClientError =
            error instanceof TRPCError &&
            (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND') &&
            !error.cause

          if (!isExpectedClientError) {
            Sentry.withScope(scope => {
              scope.setTag('trpc.path', path || 'unknown')
              if (error instanceof Error) {
                Sentry.captureException(error)
              } else {
                Sentry.captureMessage(String(error), 'error')
              }
            })
          }
        }
      },
    },
  })

  server.get('/', async () => ({ ping: 'pong' }))

  return server
}

export default createServer
