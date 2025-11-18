import type DynamoDriver from './drivers/dynamo'

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Vault driver instance (decorated on server as `server.vault`).
     * Typed to the concrete Dynamo driver so route handlers can access
     * driver-specific methods (e.g. `fetchMany`).
     */
    vault: DynamoDriver
  }
}
