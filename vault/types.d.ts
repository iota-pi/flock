import type BaseDriver from './drivers/base'

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Vault driver instance (decorated on server as `server.vault`).
     * Typed to the concrete Dynamo driver so route handlers can access
     * driver-specific methods (e.g. `fetchMany`).
     */
    vault: BaseDriver
  }
}
