import { FastifyPluginCallback } from 'fastify';
import getDriver from '../drivers';


const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = getDriver('dynamo');

  fastify.get('/', async (request, reply) => {
    return {hello: 'world'};
  });

  fastify.get('/:account/individuals', async (request, reply) => {
    const account = (request.params as { account: string }).account;
    const results = await vault.fetchAll({ account });
    return { individuals: results };
  });

  fastify.get('/:account/individuals/:individual', async (request, reply) => {
    const { account, individual } = request.params as { account: string, individual: string };
    const result = await vault.get({ account, individual });
    return { individuals: [result] };
  });

  fastify.put('/:account/individuals/:individual', async (request, reply) => {
    fastify.log.info('hello there!');
    const { account, individual } = request.params as { account: string, individual: string };
    const { data, iv } = (request.body as { data: string, iv: string });
    await vault.set({ account, individual, data, iv });
    return { success: true };
  });

  next();
}

export default routes;
