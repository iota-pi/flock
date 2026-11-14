import { createHmac } from 'crypto'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import * as Sentry from '@sentry/node'
import { TRPCError } from '@trpc/server'
import { fastifyTRPCPlugin } from '@trpc/server/adapters/fastify'
import { createFlockDriver } from '../flockDriver'
import { flockDataVersionPolicy } from '../flockDataVersion'
import { readSecret } from '../secrets'
import { appRouter } from '../trpc/root'
import { createVaultContext, type SignupThrottleOptions, type UnknownAccountParams } from '@vault/server'
import { CLIENT_OUTDATED_MESSAGE, CURRENT_SALT_VERSION, getDefaultKdf, PROTOCOL_VERSION_HEADER } from '@vault/shared'

/**
 * Writes from builds below this protocol version are rejected, which makes them update. Raising it
 * retires the server code kept only for older builds (see docs/vault-extraction.md).
 * - At 1, builds from before the protocol header (which write unbound ciphertexts) can no longer write.
 * - At 2, builds that can't derive Argon2id keys can no longer log in (`login` is a mutation), so
 *   they update instead of reporting a wrong password.
 * - At 3, builds that keep local data in plaintext stop at their next login or write and update, so
 *   they stop re-creating the plaintext stores that sealed builds retire.
 * - At 4, keyring uploads must prove the master key (`currentAuthToken`). Builds that don't send it
 *   update instead of failing a key rotation.
 * - At 5, sync moves to the log (docs/sync-design.md). Builds that still push sync messages update,
 *   and `sync.pollSync` stays only to tell them to.
 */
export const MIN_PROTOCOL_VERSION = 5

/** Lets a local server answer unknown accounts like real ones without any setup */
const DEV_UNKNOWN_ACCOUNT_SECRET = 'flock-local-unknown-account-secret'

/**
 * Made-up security parameters for accounts that don't exist, shaped like a new account's, so that
 * `getSecurityParams` doesn't reveal which accounts do. The salts are derived from
 * UNKNOWN_ACCOUNT_SECRET (an SST secret), which must stay the same, or an unknown account's salt
 * would change between requests.
 */
export function getUnknownAccountParams(devMode: boolean): UnknownAccountParams | undefined {
  const secret = readSecret('UNKNOWN_ACCOUNT_SECRET') || (devMode ? DEV_UNKNOWN_ACCOUNT_SECRET : undefined)
  if (!secret) {
    console.error('UNKNOWN_ACCOUNT_SECRET is not set, so getSecurityParams reports unknown accounts as NOT_FOUND')
    return undefined
  }
  return { secret, saltVersion: CURRENT_SALT_VERSION, kdf: getDefaultKdf() }
}

/** Separates the signup throttle's key from UNKNOWN_ACCOUNT_SECRET's other uses */
const SIGNUP_THROTTLE_KEY_LABEL = 'flock-signup-throttle'

/**
 * Limits sign-ups per network, keyed by an HMAC derived from UNKNOWN_ACCOUNT_SECRET, so it needs no
 * secret of its own. A local server has no secret, and isn't limited, so e2e runs can create as many
 * accounts as they like. `request.ip` is the Function URL's `sourceIp`, which AWS sets and clients
 * can't forge. Behind a CDN or proxy it would be the proxy's address, so every sign-up would share
 * one limit: read the client's address from the proxy's header (with `trustProxy`) before adding one.
 */
export function getSignupThrottle(): SignupThrottleOptions | undefined {
  const secret = readSecret('UNKNOWN_ACCOUNT_SECRET')
  if (!secret) return undefined
  return { secret: createHmac('sha256', secret).update(SIGNUP_THROTTLE_KEY_LABEL).digest('base64url') }
}

async function createServer(devMode = false) {
  const server = Fastify({
    logger: {
      level: devMode ? 'info' : 'warn',
    },
    bodyLimit: 10 * 1024 * 1024,
  })
  await server.register(cors, {
    origin: [
      /^https:\/\/flock(-[^.]+)?\.cross-code\.org$/,
      /^https?:\/\/localhost(:[0-9]+)?$/,
    ],
    methods: ['GET', 'PATCH', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', PROTOCOL_VERSION_HEADER],
    credentials: true,
  })

  await server.register(fastifyTRPCPlugin, {
    prefix: '/trpc',
    trpcOptions: {
      router: appRouter,
      // Clients send queries as POSTs, keeping account and item IDs out of URLs. GETs still work,
      // for builds from before that.
      allowMethodOverride: true,
      createContext: createVaultContext({
        vault: createFlockDriver(devMode),
        minProtocolVersion: MIN_PROTOCOL_VERSION,
        dataVersionPolicy: flockDataVersionPolicy,
        unknownAccountParams: getUnknownAccountParams(devMode),
        signupThrottle: getSignupThrottle(),
      }),
      onError: ({ path, error }: { path: string | undefined, error: unknown }) => {
        // Turning away an old build is routine, and a stuck tab can repeat it every few seconds.
        // Logging it would also fill the Sentry breadcrumbs of real errors.
        if (error instanceof TRPCError && error.message === CLIENT_OUTDATED_MESSAGE) return

        console.error(`[TRPC Error] path=${path}:`, error)
        if (process.env.SENTRY_DSN) {
          const isExpectedClientError =
            error instanceof TRPCError &&
            (error.code === 'UNAUTHORIZED' || error.code === 'NOT_FOUND' || error.code === 'TOO_MANY_REQUESTS') &&
            !error.cause

          if (!isExpectedClientError) {
            Sentry.withScope(scope => {
              scope.setTag('trpc.path', path || 'unknown')
              if (error instanceof Error) {
                Sentry.captureException(error)
              } else {
                Sentry.captureMessage(String(error), 'error')
              }
            })
          }
        }
      },
    },
  })

  return server
}

export default createServer
