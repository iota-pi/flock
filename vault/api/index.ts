import Fastify from 'fastify'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import routes from './routes'
import { accountParams, itemParams, itemBody, itemsBody, subscriptionParams, subscriptionBody, itemsQuery } from './schemas'
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
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE'],
  })
  await server.register(fastifyAuth)
  server.addSchema(accountParams)
  server.addSchema(itemParams)
  server.addSchema(itemBody)
  server.addSchema(itemsBody)
  server.addSchema(itemsQuery)
  server.addSchema(subscriptionParams)
  server.addSchema(subscriptionBody)

  const vault = getDriver('dynamo')
  server.decorate('vault', vault)

  await server.register(routes)
  return server
}

export default createServer
