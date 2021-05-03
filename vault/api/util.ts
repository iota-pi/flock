import { FastifyRequest } from 'fastify';
import { RouteGenericInterface } from 'fastify/types/route';
import { IncomingMessage, Server } from 'http';

export function getAuthToken(request: FastifyRequest<RouteGenericInterface, Server, IncomingMessage>) {
  const auth = request.headers.authorization || '';
  const token = auth.replace(/^[a-z]+ /i, '');
  return token;
}
