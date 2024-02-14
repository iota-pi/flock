import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, ScanCommandOutput, UpdateCommand } from '@aws-sdk/lib-dynamodb'

import { createHash } from 'crypto';
import { VaultItem } from '../drivers/base';
import { ACCOUNT_TABLE_NAME, getConnectionParams, ITEM_TABLE_NAME } from '../drivers/dynamo';

const ddb = new DynamoDBClient(getConnectionParams())
const client = DynamoDBDocumentClient.from(ddb);

const migrations: { [name: string]: () => Promise<void> } = {
  async backupAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account', 'authToken'],
    }));
    const items = results.Items as { account: string, authToken: string }[] | undefined;
    if (items) {
      for (const { account, authToken } of items) {
        await client.send(new UpdateCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET rawAuthToken = :token',
          ExpressionAttributeValues: {
            ':token': authToken,
          },
        }));
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async hashAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account', 'authToken'],
    }));
    const items = results.Items as { account: string, authToken: string }[] | undefined;
    if (items) {
      for (const { account, authToken } of items) {
        const hash = createHash('sha512');
        hash.update(Buffer.from(authToken, 'utf8'));
        await client.send(new UpdateCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET hashAuthToken = :token',
          ExpressionAttributeValues: {
            ':token': hash.digest().toString('base64'),
          },
        }));
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async installHashAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account'],
    }));
    const items = results.Items as { account: string, authToken: string }[] | undefined;
    if (items) {
      for (const { account } of items) {
        await client.send(new UpdateCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'SET authToken = hashAuthToken',
        }));
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async cleanUpAuthToken () {
    const results = await client.send(new ScanCommand({
      TableName: ACCOUNT_TABLE_NAME,
      AttributesToGet: ['account'],
    }));
    const items = results.Items as { account: string }[] | undefined;
    if (items) {
      for (const { account } of items) {
        await client.send(new UpdateCommand({
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
          UpdateExpression: 'REMOVE rawAuthToken, hashAuthToken',
        }));
      }
      console.log(`Updated ${items.length} items`);
    }
  },
  async addModifiedTime () {
    const maxItems = 10000;
    const items: VaultItem[] = [];
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined = undefined;
    while (items.length < maxItems) {
      const response = await client.send(new ScanCommand({ TableName: ITEM_TABLE_NAME }));
      if (response?.Items) {
        items.push(...response?.Items as VaultItem[]);
      }
      lastEvaluatedKey = response?.LastEvaluatedKey;
      if (!lastEvaluatedKey) {
        break;
      }
    }
    const now = new Date().getTime();
    let updated = 0;
    for (const item of items) {
      if (!item.metadata.modified) {
        await client.send(new UpdateCommand({
          TableName: ITEM_TABLE_NAME,
          Key: { account: item.account, item: item.item },
          UpdateExpression: 'SET metadata.modified = :modified',
          ExpressionAttributeValues: {
            ':modified': now,
          },
        }));
        ++updated;
      }
    }
    console.log(`Updated ${updated} items`);
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
