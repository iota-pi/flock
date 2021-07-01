import AWS from 'aws-sdk';
import { almostConstantTimeEqual } from '../util';
import BaseDriver, { AuthData, VaultAccountWithAuth, VaultData, VaultItem, VaultKey } from './base';

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts';
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems';
const DATA_ATTRIBUTES = ['metadata', 'cipher'];

export interface DynamoOptions extends AWS.DynamoDB.ClientConfiguration {}

export default class DynamoDriver<T = DynamoOptions> extends BaseDriver<T> {
  private client: AWS.DynamoDB.DocumentClient | undefined;

  async init(_options?: T) {
    const options = getConnectionParams(_options);
    const ddb = new AWS.DynamoDB(options);

    try {
      await ddb.createTable(
        {
          TableName: ITEM_TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'account',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'item',
              KeyType: 'RANGE',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
            {
              AttributeName: 'item',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ).promise();
    } catch (err) {
      if (err.code !== 'ResourceInUseException') {
        throw err;
      }
    }

    try {
      await ddb.createTable(
        {
          TableName: ACCOUNT_TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'account',
              KeyType: 'HASH',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ).promise();
    } catch (err) {
      if (err.code !== 'ResourceInUseException') {
        throw err;
      }
    }

    return this;
  }

  connect(_options?: T): DynamoDriver {
    const options = getConnectionParams(_options);
    this.client = new AWS.DynamoDB.DocumentClient(options);
    return this;
  }

  async createAccount({ account, authToken }: AuthData): Promise<boolean> {
    const response = await this.client?.get({
      TableName: ACCOUNT_TABLE_NAME,
      Key: { account },
    }).promise();
    if (response?.Item) {
      return false;
    }
    await this.client?.put({
        TableName: ACCOUNT_TABLE_NAME,
        Item: { account, authToken },
    }).promise();
    return true;
  }

  async getAccount({ account, authToken }: AuthData): Promise<VaultAccountWithAuth> {
    const response = await this.client?.get(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
      },
    ).promise();
    if (response?.Item) {
      const storedHash = response.Item.authToken as string;
      if (almostConstantTimeEqual(authToken, storedHash)) {
        return response.Item as VaultAccountWithAuth;
      }
    }
    throw new Error(`Could not find account ${account}`);
  }

  async setMetadata(
    { account, metadata }: Pick<AuthData, 'account'> & { metadata: Record<string, any> },
  ): Promise<void> {
    await this.client?.update(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
        UpdateExpression: 'SET metadata=:metadata',
        ExpressionAttributeValues: {
          ':metadata': metadata,
        },
      },
    ).promise();
  };

  async checkPassword({ account, authToken }: AuthData): Promise<boolean> {
    try {
      const result = await this.getAccount({ account, authToken });
      return !!result;
    } catch (error) {
      return false;
    }
  }

  async set(item: VaultItem) {
    await this.client?.put(
      {
        TableName: ITEM_TABLE_NAME,
        Item: item,
      },
    ).promise();
  };

  async get({ account, item }: VaultKey) {
    const response = await this.client?.get(
      {
        TableName: ITEM_TABLE_NAME,
        Key: { account, item },
        AttributesToGet: DATA_ATTRIBUTES,
      },
    ).promise();
    if (response?.Item) {
      return response.Item as VaultItem;
    } else {
      throw new Error(`Could not find item (${item}) for this account (${account})`);
    }
  };

  async fetchAll({ account }: { account: string }) {
    const response = await this.client?.query(
      {
        TableName: ITEM_TABLE_NAME,
        KeyConditionExpression: 'account = :accountid',
        ExpressionAttributeValues: {
          ':accountid': account,
        },
      },
    ).promise();
    if (!response) {
      throw new Error(`Response object is not defined ${account}`);
    }
    return response?.Items as VaultData[];
  }

  async delete({ account, item }: VaultKey) {
    await this.client?.delete({
      TableName: ITEM_TABLE_NAME,
      Key: { account, item },
    }).promise();
  }

  async deleteAll({ account }: Pick<VaultKey, 'account'>) {
    throw new Error('deleteAll is not implemented for DynamoDB');
  }
}

export function getConnectionParams(options?: DynamoOptions): DynamoOptions {
  return {
    region: 'ap-southeast-2',
    endpoint: 'http://dynamodb:8000',
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
    ...options,
  };
}
