import type { FastifyPluginCallback } from 'fastify'
import { asItemType } from '../../drivers/base'
import {
  SCHEMA_REFS,
  type ItemParams,
  type AccountParams,
  type ItemsQuery,
  type PutItemsBatchBody,
  type PutItemBody,
  type DeleteItemsBatchBody,
  type ItemsResponse,
  type SuccessResponse,
  type BatchResultResponse,
  type CachedVaultItem,
} from '../../../shared/apiTypes'

const itemsRoutes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

  fastify.get<{ Params: AccountParams; Querystring: ItemsQuery; Reply: ItemsResponse }>(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        querystring: { $ref: SCHEMA_REFS.ITEMS_QUERY },
        response: { 200: { $ref: SCHEMA_REFS.ITEMS_RESPONSE } },
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
      const results: CachedVaultItem[] = await resultPromise
      return { success: true, items: results }
    },
  )

  fastify.get<{ Params: ItemParams; Reply: ItemsResponse }>(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ITEM_PARAMS },
        response: { 200: { $ref: SCHEMA_REFS.ITEMS_RESPONSE } },
      },
    },
    async request => {
      const { account, item } = request.params
      const result = await vault.get({ account, item })
      return { success: true, items: [result] }
    }
  )

  fastify.put<{ Params: AccountParams; Body: PutItemsBatchBody; Reply: BatchResultResponse }>(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        body: { $ref: SCHEMA_REFS.ITEMS_BODY },
        response: { 200: { $ref: SCHEMA_REFS.BATCH_RESULT_RESPONSE } },
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

  fastify.put<{ Params: ItemParams; Body: PutItemBody; Reply: SuccessResponse }>(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ITEM_PARAMS },
        body: { $ref: SCHEMA_REFS.ITEM_BODY },
        response: { 200: { $ref: SCHEMA_REFS.SUCCESS_RESPONSE } },
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

  fastify.delete<{ Params: AccountParams; Body: DeleteItemsBatchBody; Reply: BatchResultResponse }>(
    '/:account/items',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        body: { $ref: SCHEMA_REFS.DELETE_ITEMS_BODY },
        response: { 200: { $ref: SCHEMA_REFS.BATCH_RESULT_RESPONSE } },
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

  fastify.delete<{ Params: ItemParams; Reply: SuccessResponse }>(
    '/:account/items/:item',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ITEM_PARAMS },
        response: { 200: { $ref: SCHEMA_REFS.SUCCESS_RESPONSE } },
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
