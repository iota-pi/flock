import { randomBytes } from 'crypto'
import type { FastifyPluginCallback } from 'fastify'
import { asItemType } from '../drivers/base'
import {
  AccountParams,
  ItemParams,
  ItemsQuery,
  ItemsBody,
  ItemBody,
  SubscriptionParams,
  SubscriptionBody,
  ACCOUNT_PARAMS_REF,
  ITEM_PARAMS_REF,
  ITEMS_QUERY_REF,
  ITEMS_BODY_REF,
  ITEM_BODY_REF,
  SUBSCRIPTION_PARAMS_REF,
  SUBSCRIPTION_BODY_REF,
} from './schemas'
import { getAuthToken, hashString } from './util'
import { HttpError } from './errors'

const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

  fastify.setErrorHandler((error: Error, request, reply) => {
    request.log.error(error)

    // If a handler threw an HttpError, respect its status code and message
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ success: false, error: error.message })
    }

    // Map any "Not Found" errors from Dynamo driver to 404
    if (
      error.message.toLowerCase().includes('could not find')
      || error.message.toLowerCase().includes('not found')
    ) {
      return reply.code(404).send({ success: false, error: 'Not Found' })
    }

    // Default to 500
    reply.code(500).send({ success: false, error: error.message })
  })

  fastify.get('/', async () => {
    fastify.log.info('ping pong response initiated')
    return { ping: 'pong' }
  })

  fastify.get<{ Params: AccountParams; Querystring: ItemsQuery }>(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
        querystring: { $ref: ITEMS_QUERY_REF },
      },
    },
    async request => {
      const { account } = request.params
      const { since, ids: idsString } = request.query
      const ids = idsString ? idsString.split(',').filter(Boolean) : []
      const resultPromise = (
        since || ids.length === 0
          ? vault.fetchAll({ account, cacheTime: since })
          : vault.fetchMany({ account, ids })
      )
      const results = await resultPromise
      return { success: true, items: results }
    },
  )

  fastify.get<{ Params: ItemParams }>(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: { $ref: ITEM_PARAMS_REF },
      },
    },
    async request => {
      const { account, item } = request.params
      const result = await vault.get({ account, item })
      return { success: true, items: [result] }
    }
  )

  fastify.put<{ Params: AccountParams; Body: ItemsBody }>(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
        body: { $ref: ITEMS_BODY_REF },
      },
    },
    async request => {
      const { account } = request.params
      const items = request.body
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

  fastify.put<{ Params: ItemParams; Body: ItemBody }>(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: { $ref: ITEM_PARAMS_REF },
        body: { $ref: ITEM_BODY_REF },
      },
    },
    async request => {
      const { account, item } = request.params
      const { cipher, iv, modified, type } = request.body
      const _type = asItemType(type)
      await vault.set({ account, item, cipher, metadata: { type: _type, iv, modified } })
      return { success: true }
    },
  )

  fastify.delete<{ Params: AccountParams; Body: string[] }>(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
        body: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    },
    async request => {
      const { account } = request.params
      const items = request.body
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

  fastify.delete<{ Params: ItemParams }>(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: { $ref: 'vault.itemParams#' },
      },
    },
    async request => {
      const { account, item } = request.params
      await vault.delete({ account, item })
      return { success: true }
    },
  )

  fastify.post<{
    Body: { salt: string; authToken: string }
  }>(
    '/account',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            salt: { type: 'string', minLength: 1 },
            authToken: { type: 'string', minLength: 1 },
          },
          required: ['salt', 'authToken'],
        },
      },
    },
    async request => {
      const account = await vault.getNewAccountId()
      const { salt, authToken } = request.body

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
      throw new HttpError(500, 'Failed to create account')
    },
  )

  fastify.post<{ Params: AccountParams; Body: { authToken: string } }>(
    '/:account/login',
    {
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
        body: {
          type: 'object',
          properties: {
            authToken: { type: 'string' },
          },
          required: ['authToken'],
        },
      },
    },
    async request => {
      const { account } = request.params
      const { authToken } = request.body
      const valid = await vault.checkSession({ account, session: authToken })
      if (!valid) {
        throw new HttpError(403, 'Unauthorized')
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

  fastify.patch<{ Params: AccountParams; Body: { metadata?: Record<string, unknown> } }>(
    '/:account',
    {
      preHandler,
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
        body: {
          type: 'object',
          properties: {
            metadata: { type: 'object' },
          },
        },
      },
    },
    async request => {
      const { account } = request.params
      const { metadata = {} } = request.body
      await vault.updateAccountData({
        account,
        metadata,
      })
      return { success: true }
    },
  )

  fastify.get<{ Params: AccountParams }>(
    '/:account/salt',
    {
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
      },
    },
    async request => {
      const { account } = request.params
      const salt = await vault.getAccountSalt({ account })
      return {
        success: true,
        salt,
      }
    },
  )

  fastify.get<{ Params: AccountParams }>(
    '/:account',
    {
      preHandler,
      schema: {
        params: { $ref: ACCOUNT_PARAMS_REF },
      },
    },
    async request => {
      const { account } = request.params
      const authToken = getAuthToken(request)
      const { metadata } = await vault.getAccount({ account, session: authToken })
      return {
        success: true,
        metadata,
      }
    },
  )

  fastify.get<{ Params: SubscriptionParams }>(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: { $ref: SUBSCRIPTION_PARAMS_REF },
      },
    },
    async request => {
      const { account, subscription } = request.params
      const result = await vault.getSubscription({
        account,
        id: subscription,
      })
      return { success: true, subscription: result }
    },
  )

  fastify.put<{ Params: SubscriptionParams; Body: SubscriptionBody }>(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: { $ref: SUBSCRIPTION_PARAMS_REF },
        body: { $ref: SUBSCRIPTION_BODY_REF },
      },
    },
    async request => {
      const { account, subscription } = request.params
      const { failures, hours, timezone, token } = request.body
      await vault.setSubscription({
        account,
        id: subscription,
        subscription: { failures, hours, timezone, token },
      })
      return { success: true }
    },
  )

  fastify.delete<{ Params: SubscriptionParams }>(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: { $ref: SUBSCRIPTION_PARAMS_REF },
      },
    },
    async request => {
      const { account, subscription } = request.params
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
