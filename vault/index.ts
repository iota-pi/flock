import awsLambdaFastify from 'aws-lambda-fastify';
import createServer from './api';

const proxy = awsLambdaFastify(createServer());
export { proxy as handler };
