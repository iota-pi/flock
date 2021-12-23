import AWS from 'aws-sdk';
import { almostConstantTimeEqual } from '../util';
import BaseDriver, {
  AuthData,
  VaultAccountWithAuth,
  VaultItem,
  VaultKey,
  VaultSubscriptionFull,
} from './base';
import { FlockPushSubscription } from '../../app/src/utils/firebase-types';

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts';
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems';
export const SUBSCRIPTION_TABLE_NAME = process.env.SUBSCRIPTIONS_TABLE || 'FlockSubscriptions';
const DATA_ATTRIBUTES = ['metadata', 'cipher'];
const ITEM_KEY_ATTRIBUTES = ['item'];

export const MAX_ITEM_SIZE = 50000;
export const MAX_ITEMS_FETCH = 5000;

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
    } catch (err: any) {
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
    } catch (err: any) {
      if (err.code !== 'ResourceInUseException') {
        throw err;
      }
    }

    try {
      await ddb.createTable(
        {
          TableName: SUBSCRIPTION_TABLE_NAME,
          KeySchema: [
            {
              AttributeName: 'id',
              KeyType: 'HASH',
            },
            {
              AttributeName: 'account',
              KeyType: 'RANGE',
            },
          ],
          AttributeDefinitions: [
            {
              AttributeName: 'id',
              AttributeType: 'S',
            },
            {
              AttributeName: 'account',
              AttributeType: 'S',
            },
          ],
          BillingMode: 'PAY_PER_REQUEST',
        },
      ).promise();
    } catch (err: any) {
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
    let success = true;
    await this.client?.put({
        TableName: ACCOUNT_TABLE_NAME,
        Item: { account, authToken: await authToken },
        ConditionExpression: 'attribute_not_exists(account)',
    }).promise().catch(reason => {
      success = false;
      if (reason.code !== 'ConditionalCheckFailedException') {
        throw reason;
      }
    });
    return success;
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
      const tokenHash = await authToken;
      if (almostConstantTimeEqual(tokenHash, storedHash)) {
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

  async setSubscription(
    {
      account,
      id,
      subscription,
    }: Pick<AuthData, 'account'> & {
      id: string,
      subscription: FlockPushSubscription,
    },
  ) {
    await this.client?.put({
      TableName: SUBSCRIPTION_TABLE_NAME,
      Item: { account, id, ...subscription },
    }).promise();
  }

  async deleteSubscription(
    {
      account,
      id,
    }: Pick<AuthData, 'account'> & {
      id: string,
    },
  ) {
    await this.client?.delete({
      TableName: SUBSCRIPTION_TABLE_NAME,
      Key: { account, id },
    }).promise();
  }

  async countSubscriptionFailure(
    { account, token, maxFailures }: Pick<AuthData, 'account'> & { token: string, maxFailures: number },
  ) {
    try {
      await this.client?.update({
        TableName: SUBSCRIPTION_TABLE_NAME,
        Key: { account, token },
        UpdateExpression: 'set failures = failures + :inc',
        ConditionExpression: 'failures < :max',
        ExpressionAttributeValues: {
          ':inc': 1,
          ':max': maxFailures,
        },
      }).promise();
    } catch (error) {
      if ((error as any).code === 'ConditionalCheckFailedException') {
        await this.client?.delete({
          TableName: SUBSCRIPTION_TABLE_NAME,
          Key: { account, token },
          ConditionExpression: 'failures >= :max',
          ExpressionAttributeValues: {
            ':max': maxFailures,
          },
        }).promise();
        console.info(`Deleting subscription after failing to push ${maxFailures} times`);
      } else {
        throw error;
      }
    }
  }

  async getSubscription(
    { account, id }: Pick<AuthData, 'account'> & { id: string },
  ): Promise<FlockPushSubscription | null> {
    const response = await this.client?.get(
      {
        TableName: SUBSCRIPTION_TABLE_NAME,
        Key: { account, id },
      },
    ).promise();
    if (response?.Item) {
      const {
        failures,
        hours,
        timezone,
        token,
      } = response.Item as VaultSubscriptionFull;
      return {
        failures,
        hours,
        timezone,
        token,
      };
    }
    return null;
  }

  async getEverySubscription() {
    // Warning: uses full table scan
    const maxItems = 1000;
    const items: VaultSubscriptionFull[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined = undefined;
    while (items.length < maxItems) {
      try {
        const scanOptions: AWS.DynamoDB.DocumentClient.ScanInput = {
          TableName: SUBSCRIPTION_TABLE_NAME,
          ExclusiveStartKey: lastEvaluatedKey,
        };
        const response = await this.client?.scan(scanOptions).promise();
        if (response?.Items) {
          items.push(...response?.Items as VaultSubscriptionFull[]);
        }
        lastEvaluatedKey = response?.LastEvaluatedKey;
        if (!lastEvaluatedKey) {
          break;
        }
      } catch (error) {
        if (items.length === 0) {
          throw new Error(`Could not scan for subscription items`);
        }
        break;
      }
    }
    return items;
  }

  async checkPassword({ account, authToken }: AuthData): Promise<boolean> {
    try {
      const result = await this.getAccount({ account, authToken });
      return !!result;
    } catch (error) {
      return false;
    }
  }

  async set(item: VaultItem) {
    if (!item.cipher || !item.metadata.iv || !item.metadata.type) {
      throw new Error(
        `Missing some required properties on item ${JSON.stringify(item)}`,
      );
    }
    const itemLength = JSON.stringify(item).length;
    if (itemLength > MAX_ITEM_SIZE) {
      throw new Error(`Item length (${itemLength}) exceeds maximum (${MAX_ITEM_SIZE})`);
    }

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
        ProjectionExpression: DATA_ATTRIBUTES.join(','),
      },
    ).promise();
    if (response?.Item) {
      return response.Item as VaultItem;
    } else {
      throw new Error(`Could not find item (${item}) for this account (${account})`);
    }
  };

  async fetchAll({ account }: { account: string }): Promise<VaultItem[]> {
    const items: VaultItem[] = [];
    let lastEvaluatedKey: AWS.DynamoDB.DocumentClient.Key | undefined = undefined;
    while (items.length < MAX_ITEMS_FETCH) {
      const response = await this.client?.query(
        {
          TableName: ITEM_TABLE_NAME,
          KeyConditionExpression: 'account = :accountid',
          ExpressionAttributeNames: {
            '#itemKey': 'item',
          },
          ExpressionAttributeValues: {
            ':accountid': account,
          },
          ProjectionExpression: ['#itemKey', ...DATA_ATTRIBUTES].join(','),
        },
      ).promise();
      if (response?.Items) {
        items.push(...response?.Items as VaultItem[]);
      }
      lastEvaluatedKey = response?.LastEvaluatedKey;
      if (!lastEvaluatedKey) {
        break;
      }
    }
    return items;
  }

  async delete({ account, item }: VaultKey) {
    await this.client?.delete({
      TableName: ITEM_TABLE_NAME,
      Key: { account, item },
    }).promise();
  }
}

export function getConnectionParams(options?: DynamoOptions): DynamoOptions {
  const customEndpoint = !!process.env.DYNAMODB_ENDPOINT;
  const endpointArgs: DynamoOptions = customEndpoint ? {
    endpoint: process.env.DYNAMODB_ENDPOINT,
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
  } : {};
  return {
    apiVersion: '2012-08-10',
    region: 'ap-southeast-2',
    ...endpointArgs,
    ...options,
  };
}
