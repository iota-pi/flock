import Fastify from 'fastify'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import {
  // Params & Query
  AccountParamsSchema,
  ItemParamsSchema,
  SubscriptionParamsSchema,
  ItemsQuerySchema,
  // Bodies
  PutItemBodySchema,
  PutItemsBatchBodySchema,
  SubscriptionBodySchema,
  CreateAccountBodySchema,
  LoginBodySchema,
  UpdateMetadataBodySchema,
  DeleteItemsBatchBodySchema,
  // Responses
  SuccessResponseSchema,
  ErrorResponseSchema,
  AccountCreationResponseSchema,
  SaltResponseSchema,
  SessionResponseSchema,
  MetadataResponseSchema,
  ItemsResponseSchema,
  BatchResultResponseSchema,
  SubscriptionGetResponseSchema,
} from '../../shared/apiTypes'
import routes from './routes'
import getDriver from '../drivers'


async function createServer() {
  const server = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
    },
  }).withTypeProvider<TypeBoxTypeProvider>()
  await server.register(cookie)
  await server.register(cors, {
    origin: [
      /^https?:\/\/([^.]+\.)?flock\.cross-code\.org$/,
      /^https?:\/\/localhost(:[0-9]+)?$/,
      /^https?:\/\/[^.]+\.wofs12.workers.dev$/,
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE'],
  })
  await server.register(fastifyAuth)

  // Register param & query schemas
  server.addSchema(AccountParamsSchema)
  server.addSchema(ItemParamsSchema)
  server.addSchema(SubscriptionParamsSchema)
  server.addSchema(ItemsQuerySchema)

  // Register body schemas
  server.addSchema(PutItemBodySchema)
  server.addSchema(PutItemsBatchBodySchema)
  server.addSchema(SubscriptionBodySchema)
  server.addSchema(CreateAccountBodySchema)
  server.addSchema(LoginBodySchema)
  server.addSchema(UpdateMetadataBodySchema)
  server.addSchema(DeleteItemsBatchBodySchema)

  // Register response schemas
  server.addSchema(SuccessResponseSchema)
  server.addSchema(ErrorResponseSchema)
  server.addSchema(AccountCreationResponseSchema)
  server.addSchema(SaltResponseSchema)
  server.addSchema(SessionResponseSchema)
  server.addSchema(MetadataResponseSchema)
  server.addSchema(ItemsResponseSchema)
  server.addSchema(BatchResultResponseSchema)
  server.addSchema(SubscriptionGetResponseSchema)

  const vault = getDriver('dynamo')
  server.decorate('vault', vault)

  await server.register(routes)
  return server
}

export default createServer
