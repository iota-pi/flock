import { FastifyPluginCallback } from 'fastify';
import getDriver from '../drivers';
import { asItemType } from '../drivers/base';
import { getAuthToken } from './util';


const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = getDriver('dynamo');

  fastify.get('/', async () => ({ ping: 'pong' }));

  fastify.get('/:account/items', async (request, reply) => {
    const account = (request.params as { account: string }).account;
    const results = await vault.fetchAll({ account });
    return { items: results };
  });

  fastify.get('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string };
    const result = await vault.get({ account, item });
    return { items: [result] };
  });

  fastify.put('/:account/items/:item', async (request, reply) => {
    fastify.log.info('hello there!');
    const { account, item } = request.params as { account: string, item: string };
    const { cipher, iv, authToken, type } = request.body as {
      cipher: string,
      iv: string,
      authToken: string,
      type: string,
    };
    const valid = await vault.checkPassword({ account, authToken });
    if (valid) {
      const _type = asItemType(type);
      await vault.set({ account, item, cipher, metadata: { type: _type, iv } });
    }
    return { success: valid };
  });

  fastify.delete('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string };
    const authToken = getAuthToken(request);
    const valid = await vault.checkPassword({ account, authToken });
    if (valid) {
      await vault.delete({ account, item });
    }
    return { success: valid };
  });

  fastify.post('/:account', async (request, reply) => {
    const { account } = request.params as { account: string };
    const authToken = getAuthToken(request);
    const success = await vault.createAccount({ account, authToken });
    return { success };
  });

  fastify.get('/:account/auth', async (request, reply) => {
    const { account } = request.params as { account: string };
    const authToken = getAuthToken(request);
    const success = await vault.checkPassword({ account, authToken });
    return { success };
  });

  next();
}

export default routes;
