import createServer from '.';

async function runServer(port = 4000) {
  const server = await createServer();
  try {
    await server.listen(port, '0.0.0.0');
  } catch (err) {
    server.log.error(err);
  }
}

runServer();
