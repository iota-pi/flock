import { awsLambdaFastify } from '@fastify/aws-lambda'
import createServer from './api'
import { handler as migrationHandler } from './migrations'
import { handler as notifierHandler } from './notifier'

const proxyPromise = createServer().then((server) =>
  awsLambdaFastify(server, {
    decorateRequest: true,
    serializeLambdaArguments: true,
  })
)

const handler = async (event: unknown, context: unknown) => {
  const proxy = await proxyPromise
  return proxy(event, context)
}

export { handler, migrationHandler, notifierHandler }
