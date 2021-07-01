import Fastify, { FastifyInstance } from 'fastify';
import cookie from 'fastify-cookie';
import cors from 'fastify-cors';
import routes from './routes';

function createServer() {
  const server: FastifyInstance = Fastify({
    logger: { level: 'info' },
  });
  server.register(cookie);
  server.register(routes);
  server.register(cors, {
    origin: [/^https?:\/\/localhost(:[0-9]+)?$/],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE'],
  });
  return server;
}

export default createServer;
