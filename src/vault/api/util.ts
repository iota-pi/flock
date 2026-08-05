import { createHash } from 'crypto'
import type { FastifyRequest } from 'fastify'
import type { RouteGenericInterface } from 'fastify/types/route'
import type { IncomingMessage, Server } from 'http'

export function getAuthToken(request: FastifyRequest<RouteGenericInterface, Server, IncomingMessage>) {
  const auth = request.headers.authorization || ''
  return auth.replace(/^[a-z]+\s+/i, '').trim()
}

export function hashString(input: string): string {
  return createHash('sha512').update(input).digest('base64')
}
