import { awsLambdaFastify } from '@fastify/aws-lambda'
import * as Sentry from '@sentry/node'
import createServer from './api'
import { handler as migrationHandler } from './migrations'

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'production',
    tracesSampleRate: 0.0,
  })
}

const proxyPromise = createServer().then(server =>
  awsLambdaFastify(server, {
    decorateRequest: true,
    serializeLambdaArguments: true,
    parseCommaSeparatedQueryParams: false,
  })
)

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
