import {
  CreateTableCommand,
  DynamoDBClient,
  DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  AuthData,
  BaseData,
  GetGlobalSyncMessagesInput,
  GetSyncMessagesInput,
  GlobalSyncMessagesPage,
  ItemFormatSummary,
  StoredAccount,
  UpdateAccountDataParams,
  VaultAccount,
  ValidatePageTokenInput,
  VaultDriver,
  VaultItem,
  PushSyncMessagesInput,
  SyncMessagesPage,
} from '../vaultDriver'
import type { ItemId, ManifestEntry } from '@vault/shared'
import { isResourceInUseError } from './dynamoErrors'
import { getConnectionParams, resolveVaultTableNames, type VaultTableNames } from './config'
import { getVaultTableDefinitions } from './tables'
import type { DynamoContext } from './commands'
import * as accountRecords from './accountRecords'
import * as itemRecords from './itemRecords'
import * as syncMessages from './syncMessages'

export interface DynamoDriverOptions {
  tables?: Partial<VaultTableNames>
  /** App-specific fields written to every new account record */
  accountDefaults?: Record<string, unknown>
  /** Most sync messages one page holds. Tests lower it so paging needs only a few messages. */
  syncMessagePageSize?: number
}

export default class DynamoDriver implements VaultDriver {
  private internalClient: DynamoDBDocumentClient | undefined
  readonly tables: VaultTableNames
  private readonly accountDefaults: Record<string, unknown>
  private readonly syncMessagePageSize: number

  constructor(options: DynamoDriverOptions = {}) {
    this.tables = resolveVaultTableNames(options.tables)
    this.accountDefaults = options.accountDefaults ?? {}
    this.syncMessagePageSize = options.syncMessagePageSize ?? syncMessages.SYNC_MESSAGE_PAGE_SIZE
  }

  get client() {
    if (!this.internalClient) {
      throw new Error('Cannot use client before initialisation')
    }
    return this.internalClient
  }

  /** Built per call, so operations use whichever client `connect` (or a test) set */
  private get context(): DynamoContext {
    return { client: this.client, tables: this.tables, syncMessagePageSize: this.syncMessagePageSize }
  }

  /** Creates any of the vault's tables that don't exist yet */
  async init(): Promise<this> {
    for (const table of getVaultTableDefinitions(this.tables)) {
      try {
        console.info(`Create table: ${table.TableName}`)
        await this.client.send(new CreateTableCommand({ ...table, BillingMode: 'PAY_PER_REQUEST' }))
        console.info(`Table created: ${table.TableName}`)
      } catch (err: unknown) {
        if (!isResourceInUseError(err)) {
          throw err
        }
        console.info(`Table already exists, skipping: ${table.TableName}`)
      }
    }

    return this
  }

  connect(options?: DynamoDBClientConfig, devMode = false): this {
    const connectionParams = getConnectionParams(options)
    const ddb = new DynamoDBClient({
      ...connectionParams,
      logger: devMode ? console : undefined,
    })
    this.internalClient = DynamoDBDocumentClient.from(ddb, {
      marshallOptions: {
        // Some item fields are optional and can be undefined (for example metadata.deleted).
        // Strip them before marshalling to avoid runtime 500s from util-dynamodb.
        removeUndefinedValues: true,
      },
    })
    return this
  }

  async createAccount(account: VaultAccount): Promise<boolean> {
    return accountRecords.createAccount(this.context, this.accountDefaults, account)
  }

  async getAccountRecord(data: BaseData): Promise<StoredAccount | undefined> {
    return accountRecords.getAccountRecord(this.context, data)
  }

  async recordFailedLogin(data: BaseData): Promise<void> {
    return accountRecords.recordFailedLogin(this.context, data)
  }

  async updateAccountData<TExtra extends object = Record<never, never>>(
    params: UpdateAccountDataParams & Partial<TExtra>,
  ): Promise<void> {
    return accountRecords.updateAccountData<TExtra>(this.context, params)
  }

  async addSession(data: AuthData & { expiry: number }): Promise<void> {
    return accountRecords.addSession(this.context, data)
  }

  async extendSession(data: AuthData): Promise<void> {
    return accountRecords.extendSession(this.context, data)
  }

  async raiseDataVersion(data: BaseData & { dataVersion: number }): Promise<void> {
    return accountRecords.raiseDataVersion(this.context, data)
  }

  async set(item: VaultItem): Promise<{ version: number }> {
    return itemRecords.setItem(this.context, item)
  }

  async fetchManifest(data: BaseData): Promise<ManifestEntry[]> {
    return itemRecords.fetchManifest(this.context, data)
  }

  async listItemFormats(data: BaseData): Promise<ItemFormatSummary[]> {
    return itemRecords.listItemFormats(this.context, data)
  }

  async fetchByIds(data: BaseData & { itemIds: ItemId[] }): Promise<VaultItem[]> {
    return itemRecords.fetchByIds(this.context, data)
  }

  async pushSyncMessagesBatch(input: PushSyncMessagesInput): Promise<void> {
    return syncMessages.pushSyncMessagesBatch(this.context, input)
  }

  async getSyncMessages(input: GetSyncMessagesInput): Promise<SyncMessagesPage> {
    return syncMessages.getSyncMessages(this.context, input)
  }

  validatePageToken(input: ValidatePageTokenInput): void {
    syncMessages.validatePageToken(input)
  }

  async getGlobalSyncMessagesAfterCursor(input: GetGlobalSyncMessagesInput): Promise<GlobalSyncMessagesPage> {
    return syncMessages.getGlobalSyncMessagesAfterCursor(this.context, input)
  }
}
