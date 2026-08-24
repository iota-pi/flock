import type BaseDriver from './drivers/base'

declare module 'fastify' {
  interface FastifyInstance {
    vault: BaseDriver
  }
}
