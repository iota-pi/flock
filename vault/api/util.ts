import { createHash } from 'crypto'
import { FastifyRequest } from 'fastify'
// eslint-disable-next-line import/no-unresolved
import { RouteGenericInterface } from 'fastify/types/route'
import { IncomingMessage, Server } from 'http'

export function getAuthToken(request: FastifyRequest<RouteGenericInterface, Server, IncomingMessage>) {
  const auth = request.headers.authorization || ''
  const token = auth.replace(/^[a-z]+ /i, '')
  const hash = createHash('sha512')
  hash.update(new Uint8Array(Buffer.from(token, 'utf8')))
  return {
    plain: token,
    hash: hash.digest().toString('base64'),
  }
}
