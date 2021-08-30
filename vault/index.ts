import awsLambdaFastify from 'aws-lambda-fastify';
import createServer from './api';
import { handler as migrationHandler } from './migrations';

const proxy = awsLambdaFastify(createServer());
export {
  proxy as handler,
  migrationHandler,
};
