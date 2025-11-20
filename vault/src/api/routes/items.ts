import type { FastifyPluginCallback } from 'fastify'
import { asItemType } from '../../drivers/base'
import {
  ItemParams,
  AccountParams,
  ItemsQuery,
  ItemsBody,
  ItemBody,
  ACCOUNT_PARAMS_REF,
  ITEM_PARAMS_REF,
  ITEMS_QUERY_REF,
  ITEMS_BODY_REF,
  ITEM_BODY_REF,
} from '../schemas'

const itemsRoutes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

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
      const cacheTime = since || undefined
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
        params: { $ref: ITEM_PARAMS_REF },
      },
    },
    async request => {
      const { account, item } = request.params
      await vault.delete({ account, item })
      return { success: true }
    },
  )

  next()
}

export default itemsRoutes
