import type { FastifyPluginCallback } from 'fastify'
import type { FlockPushSubscription } from '../../../shared/src/apiTypes'
import {
  SubscriptionParams,
  SubscriptionBody,
  SUBSCRIPTION_PARAMS_REF,
  SUBSCRIPTION_BODY_REF,
} from '../schemas'

const subscriptionsRoutes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

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
      return { success: true, subscription: result as FlockPushSubscription | null }
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

export default subscriptionsRoutes
