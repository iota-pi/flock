import AWS from 'aws-sdk';
import BaseDriver, { VaultData, VaultItem, VaultKey } from './base';

export const TABLE_NAME = 'PRMIndividuals';
const DATA_ATTRIBUTES = ['iv', 'data'];

export interface DynamoOptions extends AWS.DynamoDB.ClientConfiguration {}

export default class DynamoDriver<T = DynamoOptions> extends BaseDriver<T> {
  private client: AWS.DynamoDB.DocumentClient | undefined;

  async init(_options?: T) {
    const options = getConnectionParams(_options);
    const ddb = new AWS.DynamoDB(options);

    try {
      await ddb.createTable(
        {
          TableName: TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'account',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'individual',
              KeyType: 'RANGE',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
            {
              AttributeName: 'individual',
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

  async set(item: VaultItem) {
    await this.client?.put(
      {
        TableName: TABLE_NAME,
        Item: item,
      },
    ).promise();
  };

  async get({ account, individual }: VaultKey) {
    const response = await this.client?.get(
      {
        TableName: TABLE_NAME,
        Key: { account, individual },
        AttributesToGet: DATA_ATTRIBUTES,
      },
    ).promise();
    if (response?.Item) {
      return response.Item as VaultItem;
    } else {
      throw new Error(`Could not find individual (${individual}) for this account (${account})`);
    }
  };

  async fetchAll({ account }: { account: string }) {
    const response = await this.client?.query(
      {
        TableName: TABLE_NAME,
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

  async delete({ account, individual }: VaultKey) {
    await this.client?.delete({
      TableName: TABLE_NAME,
      Key: { account, individual },
    }).promise();
  }

  async deleteAll({ account }: Pick<VaultKey, 'account'>) {
    throw new Error('deleteAll is not implemented for DynamoDB');
  }
}

export function getConnectionParams(options?: DynamoOptions): DynamoOptions {
  return {
    region: 'ap-southeast-2',
    endpoint: 'http://localhost:8000',
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
    ...options,
  };
}
