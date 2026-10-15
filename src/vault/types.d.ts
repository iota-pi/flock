import type BaseDriver from '@vault/server/drivers/base'

declare module 'fastify' {
  interface FastifyInstance {
    vault: BaseDriver
  }
}
