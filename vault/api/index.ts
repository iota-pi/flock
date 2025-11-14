import Fastify, { FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { fastifyAuth } from '@fastify/auth'
import routes from './routes'


async function createServer() {
  const server: FastifyInstance = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
    },
  })
  await server.register(cookie)
  await server.register(cors, {
    origin: [
      /^https?:\/\/([^.]+\.)?flock\.cross-code\.org$/,
      /^https?:\/\/localhost(:[0-9]+)?$/,
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE'],
  })
  await server.register(fastifyAuth)
  await server.register(routes)
  return server
}

export default createServer
