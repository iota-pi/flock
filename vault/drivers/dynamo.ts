import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DynamoDBClient,
  DynamoDBClientConfig,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb'
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  QueryCommandOutput,
  ScanCommand,
  ScanCommandOutput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import {
  almostConstantTimeEqual,
  generateAccountId,
} from '../util'
import BaseDriver, {
  AuthData,
  BaseData,
  CachedVaultItem,
  VaultAccountWithAuth,
  VaultItem,
  VaultKey,
  VaultSubscriptionFull,
} from './base'
import type { FlockPushSubscription } from '../../app/src/utils/firebase-types'

export const ACCOUNT_TABLE_NAME = process.env.ACCOUNTS_TABLE || 'FlockAccounts'
export const ITEM_TABLE_NAME = process.env.ITEMS_TABLE || 'FlockItems'
export const SUBSCRIPTION_TABLE_NAME = process.env.SUBSCRIPTIONS_TABLE || 'FlockSubscriptions'
const DATA_ATTRIBUTES = ['metadata', 'cipher']

export const MAX_ITEM_SIZE = 50000
export const MAX_ITEMS_FETCH = 5000

export default class DynamoDriver<T extends DynamoDBClientConfig = DynamoDBClientConfig> extends BaseDriver<T> {
  private internalClient: DynamoDBDocumentClient | undefined

  get client() {
    if (!this.internalClient) {
      throw new Error('Cannot use client before initialisation')
    }
    return this.internalClient
  }

  async init(_options?: T) {
    const options = getConnectionParams(_options)
    const ddb = new DynamoDBClient(options)
    const client = DynamoDBDocumentClient.from(ddb)

    try {
      await client.send(new CreateTableCommand(
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
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
      }
    }

    try {
      await client.send(new CreateTableCommand(
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
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
      }
    }

    try {
      await client.send(new CreateTableCommand(
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
      ))
    } catch (err: unknown) {
      if (!(err instanceof ResourceInUseException)) {
        throw err
      }
    }

    return this
  }

  connect(_options?: T): DynamoDriver {
    const options = getConnectionParams(_options)
    const ddb = new DynamoDBClient(options)
    this.internalClient = DynamoDBDocumentClient.from(ddb)
    return this
  }

  async createAccount(
    {
      account,
      authToken,
      metadata,
      salt,
      session,
    }: VaultAccountWithAuth,
  ): Promise<boolean> {
    let success = true
    await this.client.send(new PutCommand({
      TableName: ACCOUNT_TABLE_NAME,
      Item: {
        account,
        authToken,
        created: Date.now(),
        lastAccess: Date.now(),
        metadata,
        salt,
        session,
      },
      ConditionExpression: 'attribute_not_exists(account)',
    })).catch(error => {
      success = false
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw error
      }
    })
    return success
  }

  async getAccount({ account, authToken, session }: AuthData): Promise<VaultAccountWithAuth> {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
      },
    ))
    if (response?.Item) {
      if (session && almostConstantTimeEqual(session, response.Item.session as string)) {
        return response.Item as VaultAccountWithAuth
      }
      const storedHash = response.Item.authToken as string
      const tokenHash = authToken
      if (almostConstantTimeEqual(tokenHash, storedHash)) {
        return response.Item as VaultAccountWithAuth
      }
    }
    throw new Error(`Could not find account ${account}`)
  }

  async getAccountSalt({ account }: BaseData): Promise<string> {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ACCOUNT_TABLE_NAME,
        Key: { account },
      },
    ))
    if (response?.Item) {
      const salt = (response.Item as VaultAccountWithAuth).salt
      if (typeof salt === 'string') {
        return salt
      }
      // Backwards compatibility: account ID used to be used as salt
      // NB: could remove this if we run an upgrade script
      return account
    }
    throw new Error(`Could not find account ${account}`)
  }

  async getNewAccountId(attempts = 10): Promise<string> {
    const account = generateAccountId()

    try {
      const response = await this.client.send(new GetCommand(
        {
          TableName: ACCOUNT_TABLE_NAME,
          Key: { account },
        },
      ))
      if (!response?.Item) {
        return account
      }
    } catch (error) {
      if (attempts === 0) {
        throw error
      }
    }

    if (attempts > 0) {
      return this.getNewAccountId(attempts - 1)
    }
    throw new Error('Could not generate new account ID')
  }

  async updateAccountData(
    {
      account,
      authToken,
      metadata,
      session,
      tempAuthToken,
    }: Partial<AuthData> & {
      metadata?: Record<string, unknown>,
      tempAuthToken?: string,
    },
  ): Promise<void> {
    const promises: Promise<unknown>[] = []
    if (tempAuthToken && authToken) {
      promises.push(
        this.client.send(new UpdateCommand(
          {
            TableName: ACCOUNT_TABLE_NAME,
            Key: { account },
            UpdateExpression: 'SET authToken=:authToken',
            ExpressionAttributeValues: {
              ':authToken': authToken,
              ':tempAuthToken': tempAuthToken,
            },
            ConditionExpression: 'authToken = :tempAuthToken OR attribute_not_exists(authToken)',
          },
        ))
      )
    }

    if (session) {
      promises.push(
        this.client.send(new UpdateCommand(
          {
            TableName: ACCOUNT_TABLE_NAME,
            Key: { account },
            UpdateExpression: 'SET #session=:session',
            ExpressionAttributeValues: {
              ':session': session,
            },
            ExpressionAttributeNames: {
              '#session': 'session',
            },
          },
        ))
      )
    }

    if (metadata && Object.keys(metadata).length > 0) {
      promises.push(
        this.client.send(new UpdateCommand(
          {
            TableName: ACCOUNT_TABLE_NAME,
            Key: { account },
            UpdateExpression: 'SET metadata=:metadata',
            ExpressionAttributeValues: {
              ':metadata': metadata,
            },
          },
        ))
      )
    }

    const results = await Promise.allSettled(promises)
    for (const result of results) {
      if (result.status === 'rejected') {
        throw result.reason
      }
    }
  }

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
    await this.client.send(new PutCommand({
      TableName: SUBSCRIPTION_TABLE_NAME,
      Item: { account, id, ...subscription },
    }))
  }

  async deleteSubscription(
    {
      account,
      id,
    }: Pick<AuthData, 'account'> & {
      id: string,
    },
  ) {
    await this.client.send(new DeleteCommand({
      TableName: SUBSCRIPTION_TABLE_NAME,
      Key: { account, id },
    }))
  }

  async countSubscriptionFailure(
    { account, token, maxFailures }: Pick<AuthData, 'account'> & { token: string, maxFailures: number },
  ) {
    try {
      await this.client.send(new UpdateCommand({
        TableName: SUBSCRIPTION_TABLE_NAME,
        Key: { account, token },
        UpdateExpression: 'set failures = failures + :inc',
        ConditionExpression: 'failures < :max',
        ExpressionAttributeValues: {
          ':inc': 1,
          ':max': maxFailures,
        },
      }))
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        await this.client.send(new DeleteCommand({
          TableName: SUBSCRIPTION_TABLE_NAME,
          Key: { account, token },
          ConditionExpression: 'failures >= :max',
          ExpressionAttributeValues: {
            ':max': maxFailures,
          },
        }))
        console.info(`Deleting subscription after failing to push ${maxFailures} times`)
      } else {
        throw error
      }
    }
  }

  async getSubscription(
    { account, id }: Pick<AuthData, 'account'> & { id: string },
  ): Promise<FlockPushSubscription | null> {
    const response = await this.client.send(new GetCommand(
      {
        TableName: SUBSCRIPTION_TABLE_NAME,
        Key: { account, id },
      },
    ))
    if (response?.Item) {
      const {
        failures,
        hours,
        timezone,
        token,
      } = response.Item as VaultSubscriptionFull
      return {
        failures,
        hours,
        timezone,
        token,
      }
    }
    return null
  }

  async getEverySubscription() {
    // Warning: uses full table scan
    const maxItems = 1000
    const items: VaultSubscriptionFull[] = []
    let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined = undefined
    while (items.length < maxItems) {
      try {
        const response: ScanCommandOutput = await this.client.send(new ScanCommand({
          TableName: SUBSCRIPTION_TABLE_NAME,
          ExclusiveStartKey: lastEvaluatedKey,
        }))

        if (response?.Items) {
          items.push(...response?.Items as object as VaultSubscriptionFull[])
        }
        lastEvaluatedKey = response?.LastEvaluatedKey
        if (!lastEvaluatedKey) {
          break
        }
      } catch (error) {
        if (items.length === 0) {
          throw new Error(`Could not scan for subscription items`)
        }
        break
      }
    }
    return items
  }

  async checkPassword({ account, authToken, session }: AuthData): Promise<boolean> {
    try {
      const result = await this.getAccount({ account, authToken, session })
      if (result) {
        await this.client.send(new UpdateCommand(
          {
            TableName: ACCOUNT_TABLE_NAME,
            Key: { account },
            UpdateExpression: 'SET lastAccess=:lastAccess',
            ExpressionAttributeValues: {
              ':lastAccess': Date.now(),
            },
          },
        ))
        return true
      }
      return false
    } catch (error) {
      return false
    }
  }

  async set(item: VaultItem) {
    if (!item.cipher || !item.metadata.iv || !item.metadata.type) {
      throw new Error(
        `Missing some required properties on item ${JSON.stringify(item)}`,
      )
    }
    const itemLength = JSON.stringify(item).length
    if (itemLength > MAX_ITEM_SIZE) {
      throw new Error(`Item length (${itemLength}) exceeds maximum (${MAX_ITEM_SIZE})`)
    }

    await this.client.send(new PutCommand(
      {
        TableName: ITEM_TABLE_NAME,
        Item: item,
      },
    ))
  }

  async get({ account, item }: VaultKey) {
    const response = await this.client.send(new GetCommand(
      {
        TableName: ITEM_TABLE_NAME,
        Key: { account, item },
        ProjectionExpression: DATA_ATTRIBUTES.join(','),
      },
    ))
    if (response?.Item) {
      return response.Item as VaultItem
    } else {
      throw new Error(`Could not find item (${item}) for this account (${account})`)
    }
  }

  async fetchMany(
    {
      account,
      ids,
    }: {
      account: string,
      ids: string[],
    },
  ) {
    if (ids.length === 0) {
      return []
    }
    const response = await this.client.send(new BatchGetCommand(
      {
        RequestItems: {
          [ITEM_TABLE_NAME]: {
            Keys: ids.map(item => ({ account, item })) ?? [],
          },
        },
      },
    ))
    return response.Responses?.[ITEM_TABLE_NAME] as VaultItem[] ?? []
  }

  async fetchAll(
    {
      account,
      cacheTime,
    }: {
      account: string,
      cacheTime?: number,
    },
  ): Promise<CachedVaultItem[]> {
    const items: VaultItem[] = []
    let lastEvaluatedKey: QueryCommandOutput['LastEvaluatedKey'] | undefined = undefined
    while (items.length < MAX_ITEMS_FETCH) {
      const response = await this.client.send(new QueryCommand(
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
      ))
      if (response?.Items) {
        items.push(...response?.Items as VaultItem[])
      }
      lastEvaluatedKey = response?.LastEvaluatedKey
      if (!lastEvaluatedKey) {
        break
      }
    }
    const updatedItems = items.map(item => {
      if (!cacheTime || !item.metadata.modified || item.metadata.modified > cacheTime) {
        return item
      } else {
        return { item: item.item } as CachedVaultItem
      }
    })
    return updatedItems
  }

  async delete({ account, item }: VaultKey) {
    await this.client.send(new DeleteCommand({
      TableName: ITEM_TABLE_NAME,
      Key: { account, item },
    }))
  }
}

export function getConnectionParams(options?: DynamoDBClientConfig): DynamoDBClientConfig {
  const customEndpoint = !!process.env.DYNAMODB_ENDPOINT
  const endpointArgs: DynamoDBClientConfig = customEndpoint ? {
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: 'local',
  } : {}
  return {
    apiVersion: '2012-08-10',
    region: 'ap-southeast-2',
    ...endpointArgs,
    ...options,
  }
}
