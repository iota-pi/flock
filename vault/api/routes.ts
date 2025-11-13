import { randomBytes } from 'crypto'
import type { FastifyPluginCallback } from 'fastify'
import type { FlockPushSubscription } from '../../app/src/utils/firebase-types'
import getDriver from '../drivers'
import { asItemType } from '../drivers/base'
import { getAuthToken, hashString } from './util'

const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = getDriver('dynamo')
  const preHandler = fastify.auth([vault.auth.bind(vault)])

  fastify.get('/', async () => {
    fastify.log.info('ping pong response initiated')
    return { ping: 'pong' }
  })

  fastify.get(
    '/:account/items',
    { preHandler },
    async (request, reply) => {
      const account = (request.params as { account: string }).account
      const cacheTime = parseInt((request.query as { since?: string }).since || '') || undefined
      const ids = ((request.query as { ids?: string }).ids || '').split(',').filter(Boolean)
      try {
        const resultPromise = (
          cacheTime || ids.length === 0
            ? vault.fetchAll({ account, cacheTime })
            : vault.fetchMany({ account, ids })
        )
        const results = await resultPromise
        return { success: true, items: results }
      } catch (error) {
        fastify.log.error(error)
        reply.code(404)
        return { success: false }
      }
    },
  )

  fastify.get(
    '/:account/items/:item',
    { preHandler },
    async (request, reply) => {
      const { account, item } = request.params as { account: string, item: string }
      try {
        const result = await vault.get({ account, item })
        return { success: true, items: [result] }
      } catch (error) {
        fastify.log.error(error)
        reply.code(404)
        return { success: false }
      }
    }
  )

  fastify.put(
    '/:account/items',
    { preHandler },
    async (request) => {
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
    { preHandler },
    async (request, reply) => {
      const { account, item } = request.params as { account: string, item: string }
      const { cipher, iv, modified, type } = request.body as {
        cipher: string,
        iv: string,
        modified: number,
        type: string,
      }
      try {
        const _type = asItemType(type)
        await vault.set({ account, item, cipher, metadata: { type: _type, iv, modified } })
      } catch (error) {
        fastify.log.error(error)
        reply.code(500)
        return { success: false }
      }
      return { success: true }
    },
  )

  fastify.delete(
    '/:account/items',
    { preHandler },
    async (request) => {
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
    { preHandler },
    async (request, reply) => {
      const { account, item } = request.params as { account: string, item: string }
      try {
        await vault.delete({ account, item })
      } catch (error) {
        fastify.log.error(error)
        reply.code(500)
        return { success: false }
      }
      return { success: true }
    },
  )

  fastify.post('/account', async (request, reply) => {
    const account = await vault.getNewAccountId()
    const { salt, authToken } = request.body as { salt?: string, authToken?: string }

    if (
      !salt?.length || typeof salt !== 'string'
      || !authToken?.length || typeof authToken !== 'string'
    ) {
      reply.code(400)
      return { account: '' }
    }

    try {
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
    } catch (error) {
      fastify.log.error(error)
    }
    reply.code(500)
    return { account: '' }
  })

  fastify.post('/:account/login', async (request, reply) => {
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
  })

  fastify.patch(
    '/:account',
    { preHandler },
    async (request, reply) => {
      const { account } = request.params as { account: string }
      const { metadata = {} } = (
        request.body as { metadata: Record<string, unknown> }
      )
      try {
        await vault.updateAccountData({
          account,
          metadata,
        })
        return { success: true }
      } catch (error) {
        fastify.log.error(error)
        reply.code(500)
        return { success: false }
      }
    }
  )

  fastify.get('/:account/salt', async (request, reply) => {
    const { account } = request.params as { account: string }
    try {
      const salt = await vault.getAccountSalt({ account })
      return {
        success: true,
        salt,
      }
    } catch (error) {
      fastify.log.error(error)
      reply.code(404)
      return { success: false }
    }
  })

  fastify.get(
    '/:account',
    { preHandler },
    async (request, reply) => {
      const { account } = request.params as { account: string }
      const authToken = getAuthToken(request)
      try {
        const { metadata } = await vault.getAccount({ account, session: authToken })
        return {
          success: true,
          metadata,
        }
      } catch (error) {
        fastify.log.error(error)
        reply.code(403)
        return { success: false }
      }
    },
  )

  fastify.get(
    '/:account/subscriptions/:subscription',
    { preHandler },
    async (request, reply) => {
      const { account, subscription } = request.params as { account: string, subscription: string }
      try {
        const result = await vault.getSubscription({
          account,
          id: subscription,
        })
        return { success: true, subscription: result }
      } catch (error) {
        fastify.log.error(error)
        reply.code(500)
        return { success: false }
      }
    },
  )

  fastify.put(
    '/:account/subscriptions/:subscription',
    { preHandler },
    async (request, reply) => {
      const { account, subscription } = request.params as { account: string, subscription: string }
      const { failures, hours, timezone, token } = (
        request.body as FlockPushSubscription
      )
      try {
        await vault.setSubscription({
          account,
          id: subscription,
          subscription: { failures, hours, timezone, token },
        })
      } catch (error) {
        fastify.log.error(error)
        reply.code(500)
        return { success: false }
      }
      return { success: true }
    },
  )

  fastify.delete(
    '/:account/subscriptions/:subscription',
    { preHandler },
    async (request, reply) => {
      const { account, subscription } = request.params as { account: string, subscription: string }
      try {
        await vault.deleteSubscription({
          account,
          id: subscription,
        })
      } catch (error) {
        fastify.log.error(error)
        reply.code(500)
        return { success: false }
      }
      return { success: true }
    },
  )

  next()
}

export default routes
