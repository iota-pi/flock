import { FastifyPluginCallback } from 'fastify';
import getDriver from '../drivers';
import { asItemType } from '../drivers/base';
import { getAuthToken } from './util';


const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = getDriver('dynamo');

  fastify.get('/', async () => ({ ping: 'pong' }));

  fastify.get('/:account/items', async (request, reply) => {
    const account = (request.params as { account: string }).account;
    const authToken = getAuthToken(request);
    const valid = await vault.checkPassword({ account, authToken });
    if (!valid) {
      reply.code(403);
      return { success: false };
    }
    try {
      const results = await vault.fetchAll({ account });
      return { success: true, items: results };
    } catch (error) {
      fastify.log.error(error);
      reply.code(404);
      return { success: false };
    }
  });

  fastify.get('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string };
    const authToken = getAuthToken(request);
    const valid = await vault.checkPassword({ account, authToken });
    if (!valid) {
      reply.code(403);
      return { success: false };
    }
    try {
      const result = await vault.get({ account, item });
      return { success: true, items: [result] };
    } catch (error) {
      fastify.log.error(error);
      reply.code(404);
      return { success: false };
    }
  });

  fastify.put('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string };
    const { cipher, iv, type } = request.body as { cipher: string, iv: string, type: string };
    const authToken = getAuthToken(request);
    const valid = await vault.checkPassword({ account, authToken });
    if (!valid) {
      reply.code(403);
      return { success: false };
    }
    try {
      const _type = asItemType(type);
      await vault.set({ account, item, cipher, metadata: { type: _type, iv } });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { success: false };
    }
    return { success: true };
  });

  fastify.delete('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string };
    const authToken = getAuthToken(request);
    const valid = await vault.checkPassword({ account, authToken });
    if (!valid) {
      reply.code(403);
      return { success: false };
    }
    try {
      await vault.delete({ account, item });
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { success: false };
    }
    return { success: true };
  });

  fastify.post('/:account', async (request, reply) => {
    const { account } = request.params as { account: string };
    const authToken = getAuthToken(request);
    try {
      const success = await vault.createAccount({ account, authToken });
      return { success };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { success: false };
    }
  });

  fastify.patch('/:account', async (request, reply) => {
    const { account } = request.params as { account: string };
    const authToken = getAuthToken(request);
    const valid = await vault.checkPassword({ account, authToken });
    if (!valid) {
      reply.code(403);
      return { success: false };
    }
    const { metadata } = request.body as { metadata: Record<string, any> };
    try {
      await vault.setMetadata({ account, metadata });
      return { success: true };
    } catch (error) {
      fastify.log.error(error);
      reply.code(500);
      return { success: false };
    }
  });

  fastify.get('/:account', async (request, reply) => {
    const { account } = request.params as { account: string };
    const authToken = getAuthToken(request);
    try {
      const { metadata } = await vault.getAccount({ account, authToken });
      return {
        success: true,
        metadata,
      };
    } catch (error) {
      reply.code(403);
      return { success: false };
    }
  });

  next();
}

export default routes;
