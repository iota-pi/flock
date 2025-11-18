import { randomBytes } from 'crypto'
import type { FastifyPluginCallback } from 'fastify'
import {
  AccountParams,
  ACCOUNT_PARAMS_REF,
} from '../schemas'
import { getAuthToken, hashString } from '../util'
import { HttpError } from '../errors'

const accountsRoutes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

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
    async (request) => {
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

  next()
}

export default accountsRoutes
