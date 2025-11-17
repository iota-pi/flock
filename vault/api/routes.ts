import { randomBytes } from 'crypto'
import type { FastifyPluginCallback } from 'fastify'
import type { FlockPushSubscription } from '../../app/src/utils/firebase-types'
import getDriver from '../drivers'
import { asItemType } from '../drivers/base'
import {
  accountParams,
  itemsBody,
  itemBody,
  itemParams,
  subscriptionBody,
  subscriptionParams,
} from './schemas'
import { getAuthToken, hashString } from './util'

const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = getDriver('dynamo')
  const preHandler = fastify.auth([vault.auth.bind(vault)])

  fastify.setErrorHandler((error: Error, request, reply) => {
    request.log.error(error)

    // Map "Not Found" errors from Dynamo driver to 404
    if (error.message.includes('Could not find') || error.message.includes('not found')) {
      return reply.code(404).send({ success: false, error: 'Not Found' })
    }

    // Map Auth/Session errors to 403
    if (error.name === 'ExpiredSessionError' || error.message.includes('Invalid session')) {
      return reply.code(403).send({ success: false, error: 'Forbidden' })
    }

    // Default to 500
    const statusCode = (error as { statusCode?: number }).statusCode || 500
    reply.code(statusCode).send({ success: false, error: error.message })
  })

  fastify.get('/', async () => {
    fastify.log.info('ping pong response initiated')
    return { ping: 'pong' }
  })

  fastify.get(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: accountParams,
        querystring: {
          type: 'object',
          properties: {
            since: { type: 'string' },
            ids: { type: 'string' },
          },
        },
      },
    },
    async request => {
      const { account } = request.params as { account: string }
      const { since, ids: idsString } = request.query as { since?: string, ids?: string }
      const cacheTime = parseInt(since || '') || undefined
      const ids = (idsString || '').split(',').filter(Boolean)
      const resultPromise = (
        cacheTime || ids.length === 0
          ? vault.fetchAll({ account, cacheTime })
          : vault.fetchMany({ account, ids })
      )
      const results = await resultPromise
      return { success: true, items: results }
    },
  )

  fastify.get(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: itemParams,
      },
    },
    async request => {
      const { account, item } = request.params as { account: string, item: string }
      const result = await vault.get({ account, item })
      return { success: true, items: [result] }
    }
  )

  fastify.put(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: accountParams,
        body: itemsBody,
      },
    },
    async request => {
      const { account } = request.params as { account: string }
      const items = request.body as {
        cipher: string,
        id: string,
        iv: string,
        modified: number,
        type: string,
      }[]
      const promises: Promise<void>[] = []
      const results: { item: string, success: boolean }[] = []
      for (const item of items) {
        const { cipher, id, iv, modified, type } = item
        const _type = asItemType(type)
        promises.push(
          vault.set({
            account,
            item: id,
            cipher,
            metadata: {
              type: _type,
              iv,
              modified,
            },
          }).then(() => {
            results.push({ item: id, success: true })
          }).catch(error => {
            fastify.log.error(error)
            results.push({ item: id, success: false })
          }),
        )
      }
      await Promise.all(promises)
      return { details: results, success: true }
    }
  )

  fastify.put(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: itemParams,
        body: itemBody,
      },
    },
    async request => {
      const { account, item } = request.params as { account: string, item: string }
      const { cipher, iv, modified, type } = request.body as {
        cipher: string,
        iv: string,
        modified: number,
        type: string,
      }
      const _type = asItemType(type)
      await vault.set({ account, item, cipher, metadata: { type: _type, iv, modified } })
      return { success: true }
    },
  )

  fastify.delete(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: accountParams,
        body: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    async request => {
      const { account } = request.params as { account: string }
      const items = request.body as string[]
      const promises: Promise<void>[] = []
      const results: { item: string, success: boolean }[] = []
      // TODO add error handling for empty items array
      for (const item of items) {
        promises.push(
          vault.delete({
            account,
            item,
          }).then(() => {
            results.push({ item, success: true })
          }).catch(error => {
            fastify.log.error(error)
            results.push({ item, success: false })
          }),
        )
      }
      await Promise.all(promises)
      return { details: results, success: true }
    },
  )

  fastify.delete(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: itemParams,
      },
    },
    async request => {
      const { account, item } = request.params as { account: string, item: string }
      await vault.delete({ account, item })
      return { success: true }
    },
  )

  fastify.post(
    '/account',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            salt: { type: 'string' },
            authToken: { type: 'string' },
          },
          required: ['salt', 'authToken'],
        },
      },
    },
    async request => {
      const account = await vault.getNewAccountId()
      const { salt, authToken } = request.body as { salt: string, authToken: string }

      const success = await vault.createAccount({
        account,
        authToken,
        metadata: {},
        salt,
        session: randomBytes(16).toString('base64'),
      })
      if (success) {
        return { account }
      }
      // If the driver returned false, raise an error to be handled by the error handler
      throw new Error('Failed to create account')
    },
  )

  fastify.post(
    '/:account/login',
    {
      schema: {
        params: accountParams,
        body: {
          type: 'object',
          properties: {
            authToken: { type: 'string' },
          },
          required: ['authToken'],
        },
      },
    },
    async (request, reply) => {
      const { account } = request.params as { account: string }
      const { authToken } = request.body as { authToken: string }
      const valid = await vault.checkSession({ account, session: authToken })
      if (!valid) {
        reply.code(403)
        return { success: false }
      }
      const session = randomBytes(16).toString('base64')
      const sessionHash = hashString(session)
      await vault.updateAccountData({
        account,
        session: sessionHash,
      })
      return { success: true, session }
    }
  )

  fastify.patch(
    '/:account',
    {
      preHandler,
      schema: {
        params: accountParams,
        body: {
          type: 'object',
          properties: {
            metadata: { type: 'object' },
          },
        },
      },
    },
    async request => {
      const { account } = request.params as { account: string }
      const { metadata = {} } = (
        request.body as { metadata: Record<string, unknown> }
      )
      await vault.updateAccountData({
        account,
        metadata,
      })
      return { success: true }
    },
  )

  fastify.get(
    '/:account/salt',
    {
      schema: {
        params: accountParams,
      },
    },
    async request => {
      const { account } = request.params as { account: string }
      const salt = await vault.getAccountSalt({ account })
      return {
        success: true,
        salt,
      }
    },
  )

  fastify.get(
    '/:account',
    {
      preHandler,
      schema: {
        params: accountParams,
      },
    },
    async request => {
      const { account } = request.params as { account: string }
      const authToken = getAuthToken(request)
      const { metadata } = await vault.getAccount({ account, session: authToken })
      return {
        success: true,
        metadata,
      }
    },
  )

  fastify.get(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: subscriptionParams,
      },
    },
    async request => {
      const { account, subscription } = request.params as { account: string, subscription: string }
      const result = await vault.getSubscription({
        account,
        id: subscription,
      })
      return { success: true, subscription: result }
    },
  )

  fastify.put(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: subscriptionParams,
        body: subscriptionBody,
      },
    },
    async request => {
      const { account, subscription } = request.params as { account: string, subscription: string }
      const { failures, hours, timezone, token } = (
        request.body as FlockPushSubscription
      )
      await vault.setSubscription({
        account,
        id: subscription,
        subscription: { failures, hours, timezone, token },
      })
      return { success: true }
    },
  )

  fastify.delete(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: subscriptionParams,
      },
    },
    async request => {
      const { account, subscription } = request.params as { account: string, subscription: string }
      await vault.deleteSubscription({
        account,
        id: subscription,
      })
      return { success: true }
    },
  )

  next()
}

export default routes
