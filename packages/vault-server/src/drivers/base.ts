import { z } from 'zod'

import type { ItemId } from '@vault/shared/ids'
import {
  VaultKeySchema,
  VaultSessionRecordSchema,
  VaultAccountSchema,
  VaultAccountWithAuthSchema,
  VaultItemSchema,
  StoredSyncMessageSchema,
} from '@vault/shared/storage'
import type { ManifestEntry, PageToken } from '@vault/shared/api'

export type VaultKey = z.infer<typeof VaultKeySchema>
export type VaultSessionRecord = z.infer<typeof VaultSessionRecordSchema>
export type VaultAccount = z.infer<typeof VaultAccountSchema>
export type VaultAccountWithAuth = z.infer<typeof VaultAccountWithAuthSchema>
export type VaultItem = z.infer<typeof VaultItemSchema>
export type StoredSyncMessage = z.infer<typeof StoredSyncMessageSchema>

export interface BaseData {
  account: string,
}

export interface AuthData extends BaseData {
  session: string,
}


export type UpdateAccountDataParams = Partial<AuthData> & {
  session?: string,
  sessions?: VaultSessionRecord[],
  keyring?: string,
  authToken?: string,
  salt?: string,
  iterations?: number,
  saltVersion?: number,
  keyringVersion?: number,
  expectedKeyringVersion?: number,
  lastAccess?: number,
}


/** How one stored item is encoded, for checking whether an account's data needs migrating */
export interface ItemFormatSummary {
  itemId: ItemId
  deleted: boolean
  hasSnapshot: boolean
  /** The ciphertext format of the snapshot (undefined for snapshots from before formats existed) */
  snapshotFormat?: number
  /** Whether the item still carries a pre-Automerge `cipher` payload */
  hasCipher: boolean
}

export type VaultDriver = BaseDriver

export default abstract class BaseDriver<T = unknown> {
  abstract init(options?: T): Promise<BaseDriver<T>>
  abstract connect(options?: T): BaseDriver<T>

  // Create a new account record. Includes `authToken` and may include a
  // pre-populated `session` for immediate login.
  abstract createAccount(data: VaultAccount): Promise<boolean>

  // Retrieve account data and validate session; `isLogin` instructs implementation
  // to validate against `authToken` instead of session hash.
  abstract getAccount(data: AuthData & { isLogin?: boolean }): Promise<VaultAccountWithAuth>

  abstract getSecurityParams(data: BaseData): Promise<{ salt: string, iterations?: number, saltVersion?: number, dataVersion?: number }>
  abstract getNewAccountId(attempts?: number): Promise<string>

  // Update account-level data. Accepts partial auth data so callers can update
  // fields independently. Apps can store their own fields on
  // the account record by passing them via `TExtra`.
  abstract updateAccountData<TExtra extends object = Record<never, never>>(
    data: UpdateAccountDataParams & Partial<TExtra>,
  ): Promise<void>

  // Extend session expiry for an account (called on authenticated requests)
  abstract extendSession(data: AuthData): Promise<void>

  // Raise the account's data version. Never lowers it.
  abstract raiseDataVersion(data: BaseData & { dataVersion: number }): Promise<void>

  // Describe how each of the account's items is stored, without loading their payloads
  abstract listItemFormats(data: BaseData): Promise<ItemFormatSummary[]>

  // Item CRUD operations
  abstract set(item: VaultItem): Promise<{ version?: number } | void>
  abstract fetchManifest(opts: Pick<VaultKey, 'account'>): Promise<Array<ManifestEntry>>
  abstract fetchByIds(opts: { account: string; itemIds: ItemId[] }): Promise<VaultItem[]>

  // Sync message operations
  abstract appendSyncMessage(input: {
    account: string
    itemId: ItemId
    entry: StoredSyncMessage
  }): Promise<void>

  abstract pushSyncMessagesBatch(input: {
    account: string
    messages: Array<{
      itemId: ItemId
      entry: StoredSyncMessage
      lastModified: number
    }>
  }): Promise<void>

  /**
   * Returns an item's messages with a cursor after `fromCursor`, in pages. Pass a page's
   * `nextPageToken` back as `pageToken` (with the same `fromCursor`) to get the next page. Throws
   * `InvalidPageTokenError` for a token this driver didn't issue for this item, or one that
   * starts before `fromCursor`.
   */
  abstract getSyncMessages(input: {
    account: string
    itemId: ItemId
    fromCursor?: number
    limit?: number
    pageToken?: PageToken
  }): Promise<{ messages: StoredSyncMessage[]; hasMore: boolean; nextPageToken?: PageToken }>

  /**
   * Returns the account's messages with a cursor after `cursor`, across items, in pages. Paging works
   * as in `getSyncMessages`, except that a token is not checked against `cursor`.
   * `scannedThroughCursor` is the highest cursor the page examined.
   */
  /**
   * Throws `InvalidPageTokenError` if the matching query would reject `pageToken`: the per-item
   * query when `itemId` is given, otherwise the account-wide one. Lets callers reject a request
   * before acting on any of it.
   */
  abstract validatePageToken(input: {
    account: string
    itemId?: ItemId
    cursor?: number
    pageToken: PageToken
  }): void

  abstract getGlobalSyncMessagesAfterCursor(input: {
    account: string
    cursor?: number
    pageToken?: PageToken
  }): Promise<{ items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>; hasMore: boolean; nextPageToken?: PageToken; scannedThroughCursor: number }>
}
