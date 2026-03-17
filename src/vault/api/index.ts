import Fastify from 'fastify'
import swagger from '@fastify/swagger'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import {
  // Params & Query
  AccountParamsSchema,
  ItemParamsSchema,
  ItemsQuerySchema,
  // Bodies
  PutItemBodySchema,
  PutItemsBatchBodySchema,
  PushSubscriptionBodySchema,
  PushSubscriptionDeleteBodySchema,
  ReminderSettingsBodySchema,
  PrayerCompletionBodySchema,
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
  ReminderSettingsResponseSchema,
  ItemsResponseSchema,
  BatchResultResponseSchema,
} from './schemas'
import routes from './routes'
import getDriver from '../drivers'


async function createServer() {
  const server = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
    },
  }).withTypeProvider<TypeBoxTypeProvider>()
  await server.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: 'Flock Vault API',
        version: '1.0.0',
      },
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

  // Register param & query schemas
  server.addSchema(AccountParamsSchema)
  server.addSchema(ItemParamsSchema)
  server.addSchema(ItemsQuerySchema)

  // Register body schemas
  server.addSchema(PutItemBodySchema)
  server.addSchema(PutItemsBatchBodySchema)
  server.addSchema(PushSubscriptionBodySchema)
  server.addSchema(PushSubscriptionDeleteBodySchema)
  server.addSchema(ReminderSettingsBodySchema)
  server.addSchema(PrayerCompletionBodySchema)
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
  server.addSchema(ReminderSettingsResponseSchema)
  server.addSchema(ItemsResponseSchema)
  server.addSchema(BatchResultResponseSchema)

  const vault = getDriver('dynamo')
  server.decorate('vault', vault)

  await server.register(routes)
  server.get('/docs/json', {
    schema: {
      hide: true,
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  }, async () => server.swagger() as unknown as Record<string, unknown>)
  return server
}

export default createServer
