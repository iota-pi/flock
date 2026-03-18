import createServer from '.'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function runServer(port = 4000) {
  process.env.DYNAMODB_ENDPOINT ??= 'http://localhost:8000'

  let retries = 10
  while (retries > 0) {
    const server = await createServer()

    // 1. Track all raw TCP connections so we can sever them instantly
    const sockets = new Set<any>()
    server.server.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })

    // 2. The Worker-Thread-Safe Shutdown Handler
    const exitHandler = async () => {
      // Force-kill all active connections (React keep-alives)
      for (const socket of sockets) {
        socket.destroy()
      }

      // Cleanly close the server so the Master Process releases the port
      try {
        await server.close()
      } catch (e) {}

      process.exit(0)
    }

    // Clean up old listeners in case of retries
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGUSR2')

    process.on('SIGTERM', exitHandler)
    process.on('SIGINT', exitHandler)
    process.on('SIGUSR2', exitHandler)

    try {
      await server.listen({ port, host: '0.0.0.0' })
      server.log.info(`Vault API server running on port ${port}`)
      return // Success!
    } catch (err: any) {
      if (err.code === 'EADDRINUSE') {
        server.log.warn(`Port ${port} in use, waiting for OS to release it... (${retries} attempts left)`)
        retries--
        await wait(500)
      } else {
        server.log.error(err)
        process.exit(1)
      }
    }
  }

  console.error(`Could not bind to port ${port} after multiple attempts.`)
  process.exit(1)
}

runServer()
