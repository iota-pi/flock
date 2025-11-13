import { hash } from 'crypto'
import { FastifyRequest } from 'fastify'
// eslint-disable-next-line import/no-unresolved
import { RouteGenericInterface } from 'fastify/types/route'
import { IncomingMessage, Server } from 'http'

export function getAuthToken(request: FastifyRequest<RouteGenericInterface, Server, IncomingMessage>) {
  const auth = request.headers.authorization || ''
  const token = auth.replace(/^[a-z]+ /i, '')
  return hashString(token)
}

export function hashString(input: string): string {
  return Buffer.from(hash('sha512', input)).toString('base64')
}
