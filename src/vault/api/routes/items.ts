import type { FastifyPluginCallback } from 'fastify'
import pMap from 'p-map'
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
      const results = await pMap(
        items,
        async item => {
          const { cipher, id, iv, modified, type, version } = item
          const _type = asItemType(type)
          try {
            await vault.set({
              account,
              item: id,
              cipher,
              metadata: {
                type: _type,
                iv,
                modified,
                version,
              },
            })
            return { item: id, success: true }
          } catch (error) {
            fastify.log.error(error)
            return {
              item: id,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        { concurrency: 10 },
      )
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
      const { cipher, iv, modified, type, version } = request.body
      const _type = asItemType(type)
      await vault.set({ account, item, cipher, metadata: { type: _type, iv, modified, version } })
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
      const results = await pMap(
        items,
        async item => {
          try {
            await vault.delete({ account, item })
            return { item, success: true }
          } catch (error) {
            fastify.log.error(error)
            return {
              item,
              success: false,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        },
        { concurrency: 10 },
      )
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
