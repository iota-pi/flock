import Fastify, { FastifyInstance } from 'fastify';
import cookie from 'fastify-cookie';
import cors from 'fastify-cors';
import routes from './routes';
import logger from '../logging';


function createServer() {
  const server: FastifyInstance = Fastify({ logger });
  server.register(cookie);
  server.register(routes);
  server.register(cors, {
    origin: [
      /^https?:\/\/([^.]+\.)?flock\.cross-code\.org$/,
      /^https?:\/\/localhost(:[0-9]+)?$/,
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE'],
  });
  return server;
}

export default createServer;
