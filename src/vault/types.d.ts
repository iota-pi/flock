import type { BaseDriver } from '@vault/server'

declare module 'fastify' {
  interface FastifyInstance {
    vault: BaseDriver
  }
}
