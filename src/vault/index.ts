import * as Sentry from '@sentry/node'
import createServer, { createLambdaProxy } from './api'
import { handler as migrationHandler } from './migrations'
import { getServerSentryConfig } from './sentry'

if (process.env.SENTRY_DSN) {
  Sentry.init(getServerSentryConfig(process.env.SENTRY_DSN))
}

const proxyPromise = createServer().then(createLambdaProxy)

const handler = async (event: unknown, context: unknown) => {
  try {
    const proxy = await proxyPromise
    return await proxy(event, context)
  } catch (error) {
    if (process.env.SENTRY_DSN) {
      Sentry.captureException(error)
      await Sentry.flush(2000)
    }
    throw error
  }
}

export {
  handler,
  migrationHandler,
}
