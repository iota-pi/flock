import server from '.';

async function runServer(port = 4000) {
  try {
    await server.listen(port, '0.0.0.0');
  } catch (err) {
    server.log.error(err);
  }
}

export default runServer;
