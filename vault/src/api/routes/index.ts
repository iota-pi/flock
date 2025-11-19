import type { FastifyPluginCallback } from 'fastify'
import { accountParams, itemParams, itemBody, itemsBody, subscriptionParams, subscriptionBody, itemsQuery } from '../schemas'
import itemsRoutes from './items'
import accountsRoutes from './accounts'
import subscriptionsRoutes from './subscriptions'
import { HttpError } from '../errors'

const routes: FastifyPluginCallback = (fastify, opts, next) => {
  // Centralized error handler
  fastify.setErrorHandler((error: Error, request, reply) => {
    request.log.error(error)

    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ success: false, error: error.message })
    }

    if (
      error.message.toLowerCase().includes('could not find')
      || error.message.toLowerCase().includes('not found')
    ) {
      return reply.code(404).send({ success: false, error: 'Not Found' })
    }

    reply.code(500).send({ success: false, error: error.message })
  })

  // Lightweight health check
  fastify.get('/', async () => {
    fastify.log.info('ping pong response initiated')
    return { ping: 'pong' }
  })

  // Register resource route modules
  void fastify.register(itemsRoutes)
  void fastify.register(accountsRoutes)
  void fastify.register(subscriptionsRoutes)

  next()
}

export default routes
