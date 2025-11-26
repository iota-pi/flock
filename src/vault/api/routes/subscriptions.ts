import type { FastifyPluginCallback } from 'fastify'
import {
  SCHEMA_REFS,
  type FlockPushSubscription,
  type SubscriptionParams,
  type SubscriptionBody,
  type SubscriptionGetResponse,
  type SuccessResponse,
} from '../../../shared/apiTypes'

const subscriptionsRoutes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

  fastify.get<{ Params: SubscriptionParams; Reply: SubscriptionGetResponse }>(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.SUBSCRIPTION_PARAMS },
        response: { 200: { $ref: SCHEMA_REFS.SUBSCRIPTION_GET_RESPONSE } },
      },
    },
    async request => {
      const { account, subscription } = request.params
      const result = await vault.getSubscription({
        account,
        id: subscription,
      })
      return { success: true, subscription: result as FlockPushSubscription | null }
    },
  )

  fastify.put<{ Params: SubscriptionParams; Body: SubscriptionBody; Reply: SuccessResponse }>(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.SUBSCRIPTION_PARAMS },
        body: { $ref: SCHEMA_REFS.SUBSCRIPTION_BODY },
        response: { 200: { $ref: SCHEMA_REFS.SUCCESS_RESPONSE } },
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

  fastify.delete<{ Params: SubscriptionParams; Reply: SuccessResponse }>(
    '/:account/subscriptions/:subscription',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.SUBSCRIPTION_PARAMS },
        response: { 200: { $ref: SCHEMA_REFS.SUCCESS_RESPONSE } },
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

export default subscriptionsRoutes
