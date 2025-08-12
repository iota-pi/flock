import { randomBytes } from 'crypto'
import type { FastifyPluginCallback } from 'fastify'
import type { FlockPushSubscription } from '../../app/src/utils/firebase-types'
import getDriver from '../drivers'
import { asItemType } from '../drivers/base'
import { getAuthToken } from './util'


const routes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = getDriver('dynamo')

  fastify.get('/', async () => {
    fastify.log.info('ping pong response initiated')
    return { ping: 'pong' }
  })

  fastify.get('/:account/items', async (request, reply) => {
    const account = (request.params as { account: string }).account
    const cacheTime = parseInt((request.query as { since?: string }).since || '') || undefined
    const ids = ((request.query as { ids?: string }).ids || '').split(',').filter(Boolean)
    const authToken = getAuthToken(request)
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      reply.code(403)
      return { success: false }
    }
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
  })

  fastify.get('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string }
    const authToken = getAuthToken(request)
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      reply.code(403)
      return { success: false }
    }
    try {
      const result = await vault.get({ account, item })
      return { success: true, items: [result] }
    } catch (error) {
      fastify.log.error(error)
      reply.code(404)
      return { success: false }
    }
  })

  fastify.put('/:account/items', async (request, reply) => {
    const { account } = request.params as { account: string }
    const authToken = getAuthToken(request)
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      reply.code(403)
      return { details: [], success: false }
    }

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
  })

  fastify.put('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string }
    const { cipher, iv, modified, type } = request.body as {
      cipher: string,
      iv: string,
      modified: number,
      type: string,
    }
    const authToken = getAuthToken(request)
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      reply.code(403)
      return { success: false }
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
  })

  fastify.delete('/:account/items', async (request, reply) => {
    const { account } = request.params as { account: string }
    const authToken = getAuthToken(request)
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      reply.code(403)
      return { details: [], success: false }
    }

    const items = request.body as string[]
    const promises: Promise<void>[] = []
    const results: { item: string, success: boolean }[] = []
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
  })

  fastify.delete('/:account/items/:item', async (request, reply) => {
    const { account, item } = request.params as { account: string, item: string }
    const authToken = getAuthToken(request)
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      reply.code(403)
      return { success: false }
    }
    try {
      await vault.delete({ account, item })
    } catch (error) {
      fastify.log.error(error)
      reply.code(500)
      return { success: false }
    }
    return { success: true }
  })

  fastify.post('/account', async (request, reply) => {
    const account = await vault.getNewAccountId()
    const salt = randomBytes(16).toString('base64')
    const tempAuthToken = randomBytes(16).toString('base64')

    try {
      const success = await vault.createAccount({
        account,
        metadata: {},
        salt,
        authToken: Promise.resolve(tempAuthToken),
      })
      if (success) {
        return { account, salt, tempAuthToken }
      }
    } catch (error) {
      fastify.log.error(error)
    }
    reply.code(500)
    return { account: '', salt: '', tempAuthToken: '' }
  })

  fastify.patch('/:account', async (request, reply) => {
    const { account } = request.params as { account: string }
    const authToken = getAuthToken(request)
    let { metadata = {}, tempAuthToken = '' } = (
      request.body as { metadata: Record<string, unknown>, tempAuthToken: string }
    )
    const valid = await vault.checkPassword({ account, authToken })
    if (!valid) {
      if (metadata && Object.keys(metadata).length > 0) {
        if (tempAuthToken) {
          metadata = {}
        } else {
          reply.code(403)
          return { success: false }
        }
      }
    }
    try {
      await vault.setMetadata({ account, authToken, metadata, tempAuthToken })
      return { success: true }
    } catch (error) {
      fastify.log.error(error)
      reply.code(500)
      return { success: false }
    }
  })

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

  fastify.get('/:account', async (request, reply) => {
    const { account } = request.params as { account: string }
    const authToken = getAuthToken(request)
    try {
      const { metadata } = await vault.getAccount({ account, authToken })
      return {
        success: true,
        metadata,
      }
    } catch (error) {
      reply.code(403)
      return { success: false }
    }
  })

  fastify.get('/:account/subscriptions/:subscription', async (request, reply) => {
    const authToken = getAuthToken(request)
    const { account, subscription } = request.params as { account: string, subscription: string }
    const valid = await vault.checkPassword({
      account,
      authToken,
    })
    if (!valid) {
      reply.code(403)
      return { success: false }
    }
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
  })

  fastify.put('/:account/subscriptions/:subscription', async (request, reply) => {
    const authToken = getAuthToken(request)
    const { account, subscription } = request.params as { account: string, subscription: string }
    const { failures, hours, timezone, token } = (
      request.body as FlockPushSubscription
    )
    const valid = await vault.checkPassword({
      account,
      authToken,
    })
    if (!valid) {
      reply.code(403)
      return { success: false }
    }
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
  })

  fastify.delete('/:account/subscriptions/:subscription', async (request, reply) => {
    const authToken = getAuthToken(request)
    const { account, subscription } = request.params as { account: string, subscription: string }
    const valid = await vault.checkPassword({
      account,
      authToken,
    })
    if (!valid) {
      reply.code(403)
      return { success: false }
    }
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
  })

  next()
}

export default routes
