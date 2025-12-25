import createServer from '.'

async function runServer(port = 4000) {
  process.env.DYNAMODB_ENDPOINT ??= 'http://localhost:8000'
  const server = await createServer()
  try {
    await server.listen({
      port,
      host: '0.0.0.0',
    })
  } catch (err) {
    server.log.error(err)
  }
}

runServer()
