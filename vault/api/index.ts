import Fastify, { FastifyInstance } from 'fastify';

const server: FastifyInstance = Fastify({
  logger: { level: 'info' },
});
server.get('/', async (request, reply) => {
  server.log.info('route / handled');
  return { hello: 'world' };
});
export default server;
