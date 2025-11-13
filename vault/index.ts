import awsLambdaFastify from '@fastify/aws-lambda'
import createServer from './api'
import { handler as migrationHandler } from './migrations'
import { handler as notifierHandler } from './notifier'


const proxyPromise = createServer().then(server => awsLambdaFastify(server))

const handler = (event: unknown, context: unknown, callback?: unknown) =>
  proxyPromise.then(proxy => (proxy as any)(event, context, callback)
)

export {
  handler,
  migrationHandler,
  notifierHandler,
}
