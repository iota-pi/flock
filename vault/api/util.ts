import { createHash } from 'crypto';
import { FastifyRequest } from 'fastify';
import { RouteGenericInterface } from 'fastify/types/route';
import { IncomingMessage, Server } from 'http';

export async function getAuthToken(request: FastifyRequest<RouteGenericInterface, Server, IncomingMessage>) {
  const auth = request.headers.authorization || '';
  const token = auth.replace(/^[a-z]+ /i, '');
  const hash = createHash('sha512');
  hash.update(Buffer.from(token, 'utf8'));
  return hash.digest().toString('base64');
}
