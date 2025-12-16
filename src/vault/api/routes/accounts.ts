import { randomBytes } from 'crypto'
import type { FastifyPluginCallback } from 'fastify'
import {
  SCHEMA_REFS,
  type AccountParams,
  type CreateAccountBody,
  type LoginBody,
  type UpdateMetadataBody,
  type AccountCreationResponse,
  type SessionResponse,
  type SuccessResponse,
  type SaltResponse,
  type MetadataResponse,
} from '../../../shared/apiTypes'
import { getAuthToken, hashString } from '../util'
import { HttpError } from '../errors'

const accountsRoutes: FastifyPluginCallback = (fastify, opts, next) => {
  const vault = fastify.vault
  const preHandler = fastify.auth([vault.auth.bind(vault)])

  fastify.post<{ Body: CreateAccountBody; Reply: AccountCreationResponse }>(
    '/account',
    {
      schema: {
        body: { $ref: SCHEMA_REFS.CREATE_ACCOUNT_BODY },
        response: { 200: { $ref: SCHEMA_REFS.ACCOUNT_CREATION_RESPONSE } },
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

  fastify.post<{ Params: AccountParams; Body: LoginBody; Reply: SessionResponse }>(
    '/:account/login',
    {
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        body: { $ref: SCHEMA_REFS.LOGIN_BODY },
        response: { 200: { $ref: SCHEMA_REFS.SESSION_RESPONSE } },
      },
    },
    async request => {
      const { account } = request.params
      const { authToken } = request.body
      const valid = await vault.checkSession({
        account,
        session: authToken,
        isLogin: true,
      })
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

  fastify.patch<{ Params: AccountParams; Body: UpdateMetadataBody; Reply: SuccessResponse }>(
    '/:account',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        body: { $ref: SCHEMA_REFS.UPDATE_METADATA_BODY },
        response: { 200: { $ref: SCHEMA_REFS.SUCCESS_RESPONSE } },
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

  fastify.get<{ Params: AccountParams; Reply: SaltResponse }>(
    '/:account/salt',
    {
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        response: { 200: { $ref: SCHEMA_REFS.SALT_RESPONSE } },
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

  fastify.get<{ Params: AccountParams; Reply: MetadataResponse }>(
    '/:account',
    {
      preHandler,
      schema: {
        params: { $ref: SCHEMA_REFS.ACCOUNT_PARAMS },
        response: { 200: { $ref: SCHEMA_REFS.METADATA_RESPONSE } },
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
