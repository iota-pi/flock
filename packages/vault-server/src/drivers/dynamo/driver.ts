import {
  CreateTableCommand,
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb'
import type {
  AppendLogInput,
  AuthData,
  BaseData,
  FetchedVaultItem,
  ItemFormatSummary,
  LogPushResult,
  ReadLogInput,
  StoredAccount,
  SyncLogPage,
  UpdateAccountDataParams,
  VaultAccount,
  VaultDriver,
  VaultItem,
} from '../vaultDriver'
import type { ItemId, ManifestEntry } from '@vault/shared'
import { isResourceInUseError } from './dynamoErrors'
import { getConnectionParams, resolveVaultTableNames, type VaultTableNames } from './config'
import { getVaultTableDefinitions } from './tables'
import type { DynamoContext } from './commands'
import type { FailedLoginRecord } from '../../loginThrottle'
import * as accountRecords from './accountRecords'
import * as loginThrottleRecords from './loginThrottleRecords'
import * as itemRecords from './itemRecords'
import * as syncLog from './syncLog'

export interface DynamoDriverOptions {
  tables?: Partial<VaultTableNames>
  /** App-specific fields written to every new account record */
  accountDefaults?: Record<string, unknown>
  /** Most log rows one page holds. Tests lower it so paging needs only a few rows. */
  syncLogPageSize?: number
}

export default class DynamoDriver implements VaultDriver {
  private internalClient: DynamoDBDocumentClient | undefined
  readonly tables: VaultTableNames
  private readonly accountDefaults: Record<string, unknown>
  private readonly syncLogPageSize: number

  constructor(options: DynamoDriverOptions = {}) {
    this.tables = resolveVaultTableNames(options.tables)
    this.accountDefaults = options.accountDefaults ?? {}
    this.syncLogPageSize = options.syncLogPageSize ?? syncLog.SYNC_LOG_PAGE_SIZE
  }

  get client() {
    if (!this.internalClient) {
      throw new Error('Cannot use client before initialisation')
    }
    return this.internalClient
  }

  /** Built per call, so operations use whichever client `connect` (or a test) set */
  private get context(): DynamoContext {
    return {
      client: this.client,
      tables: this.tables,
      syncLogPageSize: this.syncLogPageSize,
    }
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

  async getLoginThrottle(data: BaseData): Promise<FailedLoginRecord> {
    return loginThrottleRecords.getLoginThrottle(this.context, data)
  }

  async recordFailedLogin(data: BaseData): Promise<void> {
    return loginThrottleRecords.recordFailedLogin(this.context, data)
  }

  async removeLoginDevice(data: BaseData & { device: string }): Promise<void> {
    return accountRecords.removeLoginDevice(this.context, data)
  }

  async updateAccountData<TExtra extends object = Record<never, never>>(
    params: UpdateAccountDataParams & Partial<TExtra>,
  ): Promise<void> {
    return accountRecords.updateAccountData<TExtra>(this.context, params)
  }

  async addSession(data: AuthData & { expiry: number, device?: string }): Promise<void> {
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

  async fetchByIds(data: BaseData & { itemIds: ItemId[] }): Promise<FetchedVaultItem[]> {
    return itemRecords.fetchByIds(this.context, data)
  }

  async appendLog(input: AppendLogInput): Promise<LogPushResult[]> {
    return syncLog.appendLog(this.context, input)
  }

  async readLog(input: ReadLogInput): Promise<SyncLogPage> {
    return syncLog.readLog(this.context, input)
  }

  async readLogHead(data: BaseData): Promise<number> {
    return syncLog.readLogHead(this.context, data)
  }
}
