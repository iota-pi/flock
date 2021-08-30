import AWS from 'aws-sdk';
import { createHash } from 'crypto';
import { ACCOUNT_TABLE_NAME, getConnectionParams } from '../drivers/dynamo';

const client = new AWS.DynamoDB.DocumentClient(getConnectionParams());

const migrations: { [name: string]: () => Promise<void> } = {
  async backupAuthToken () {
    const results = await client.scan({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account', 'authToken'],
    }).promise();
    const items = results.Items as { account: string, authToken: string }[] | undefined;
    if (items) {
      for (const { account, authToken } of items) {
        await client.update({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET rawAuthToken = :token',
          ExpressionAttributeValues: {
            ':token': authToken,
          },
        }).promise();
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async hashAuthToken () {
    const results = await client.scan({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account', 'authToken'],
    }).promise();
    const items = results.Items as { account: string, authToken: string }[] | undefined;
    if (items) {
      for (const { account, authToken } of items) {
        const hash = createHash('sha512');
        hash.update(Buffer.from(authToken, 'utf8'));
        await client.update({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET hashAuthToken = :token',
          ExpressionAttributeValues: {
            ':token': hash.digest().toString('base64'),
          },
        }).promise();
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async installHashAuthToken () {
    const results = await client.scan({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account'],
    }).promise();
    const items = results.Items as { account: string, authToken: string }[] | undefined;
    if (items) {
      for (const { account } of items) {
        await client.update({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET authToken = hashAuthToken',
        }).promise();
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async cleanUpAuthToken () {
    const results = await client.scan({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account'],
    }).promise();
    const items = results.Items as { account: string }[] | undefined;
    if (items) {
      for (const { account } of items) {
        await client.update({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'REMOVE rawAuthToken, hashAuthToken',
        }).promise();
      }
      console.log(`Updated ${items.length} items`);
    }
  },
};

export const handler = async (event: { migrationName: string }) => {
  const { migrationName } = event;
  const migration = migrations[migrationName];
  if (migration === undefined) {
    throw new Error(`Unknown migration ${migrationName}`);
  }
  await migration();
}
