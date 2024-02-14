import awsLambdaFastify from '@fastify/aws-lambda';
import createServer from './api';
import { handler as migrationHandler } from './migrations';
import { handler as notifierHandler } from './notifier';

const proxy = awsLambdaFastify(createServer());
export {
  proxy as handler,
  migrationHandler,
  notifierHandler,
};
