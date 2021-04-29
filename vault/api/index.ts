import Fastify, { FastifyInstance } from 'fastify';
import cookie from 'fastify-cookie';
import routes from './routes';

async function createServer() {
  const server: FastifyInstance = Fastify({
    logger: { level: 'info' },
  });
  server.register(cookie);
  server.register(routes);
  return server;
}

export default createServer;
