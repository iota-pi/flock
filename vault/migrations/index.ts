import AWS from 'aws-sdk';
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
};

export const handler = async (event: { migrationName: string }) => {
  const { migrationName } = event;
  const migration = migrations[migrationName];
  if (migration === undefined) {
    throw new Error(`Unknown migration ${migrationName}`);
  }
  await migration();
}
