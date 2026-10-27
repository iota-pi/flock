import { z } from 'zod'

import type { ItemId, KdfParams, ManifestEntry, PageToken } from '@vault/shared'
import type { FailedLoginRecord } from '../loginThrottle'
import {
  VaultSessionRecordSchema,
  VaultAccountSchema,
  VaultAccountWithAuthSchema,
  VaultItemSchema,
  StoredSyncMessageSchema,
} from '@vault/shared'

export type VaultSessionRecord = z.infer<typeof VaultSessionRecordSchema>
export type VaultAccount = z.infer<typeof VaultAccountSchema>
export type VaultAccountWithAuth = z.infer<typeof VaultAccountWithAuthSchema>
export type VaultItem = z.infer<typeof VaultItemSchema>
export type StoredSyncMessage = z.infer<typeof StoredSyncMessageSchema>
/** An account record as stored, before its credentials are checked (see authentication.ts) */
export type StoredAccount = VaultAccount & FailedLoginRecord

export interface BaseData {
  account: string,
}

/** What a client needs to derive an account's master key, plus its data version */
export interface SecurityParams {
  salt: string,
  iterations?: number,
  saltVersion?: number,
  kdf?: KdfParams,
  dataVersion?: number,
}

export interface AuthData extends BaseData {
  session: string,
}

export type UpdateAccountDataParams = BaseData & {
  sessions?: VaultSessionRecord[],
  keyring?: string,
  authToken?: string,
  salt?: string,
  saltVersion?: number,
  kdf?: KdfParams,
  keyringVersion?: number,
  expectedKeyringVersion?: number,
}

/** How one stored item is encoded, for checking whether an account's data needs migrating */
export interface ItemFormatSummary {
  itemId: ItemId
  deleted: boolean
  hasSnapshot: boolean
  /** The ciphertext format of the snapshot (undefined for snapshots from before formats existed) */
  snapshotFormat?: number
  /** The key version the snapshot is encrypted with (undefined for snapshots from before versions, which mean '1') */
  snapshotKver?: string
  /** Whether the item still carries a pre-Automerge `cipher` payload */
  hasCipher: boolean
}

export interface PushSyncMessagesInput {
  account: string
  messages: Array<{
    itemId: ItemId
    entry: StoredSyncMessage
  }>
}

export interface GetSyncMessagesInput {
  account: string
  itemId: ItemId
  fromCursor?: number
  pageToken?: PageToken
}

export interface SyncMessagesPage {
  messages: StoredSyncMessage[]
  hasMore: boolean
  nextPageToken?: PageToken
}

export interface ValidatePageTokenInput {
  account: string
  itemId?: ItemId
  cursor?: number
  pageToken: PageToken
}

export interface GetGlobalSyncMessagesInput {
  account: string
  cursor?: number
  pageToken?: PageToken
}

export interface GlobalSyncMessagesPage {
  items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>
  hasMore: boolean
  nextPageToken?: PageToken
  /** The highest cursor the page examined */
  scannedThroughCursor: number
}

/**
 * The storage the vault's routers and services run on. Setting a driver up (connecting, creating
 * tables) is up to each implementation.
 */
export interface VaultDriver {
  /**
   * Creates an account record with no sessions. Returns false when the account already exists.
   */
  createAccount(data: VaultAccount): Promise<boolean>

  /**
   * Reads the account record with a strongly consistent read, or undefined when there is none.
   * Callers check credentials against it with `authenticateLogin` or `authenticateSession`.
   */
  getAccountRecord(data: BaseData): Promise<StoredAccount | undefined>

  /** Counts a failed login towards the account's limit. Does nothing for an account that doesn't exist. */
  recordFailedLogin(data: BaseData): Promise<void>

  /** Throws `AuthenticationError` when the account doesn't exist */
  getSecurityParams(data: BaseData): Promise<SecurityParams>

  /** Returns an account ID that no account has yet */
  getNewAccountId(): Promise<string>

  /**
   * Updates the given account fields, leaving the others as they are. Apps can store their own
   * fields on the account record by passing them via `TExtra`. Throws `AuthenticationError` when
   * the account doesn't exist, and `VersionConflictError` when `expectedKeyringVersion` is given
   * and doesn't match.
   */
  updateAccountData<TExtra extends object = Record<never, never>>(
    data: UpdateAccountDataParams & Partial<TExtra>,
  ): Promise<void>

  /** Adds a session to an account, keeping its other active sessions (called on login) */
  addSession(data: AuthData & { expiry: number }): Promise<void>

  /** Extends a session's expiry (called on authenticated requests) */
  extendSession(data: AuthData): Promise<void>

  /** Raises the account's data version. Never lowers it. */
  raiseDataVersion(data: BaseData & { dataVersion: number }): Promise<void>

  /** Describes how each of the account's items is stored, without loading their payloads */
  listItemFormats(data: BaseData): Promise<ItemFormatSummary[]>

  /** Writes an item and returns the version the write gave it */
  set(item: VaultItem): Promise<{ version: number }>

  /** Lists every item the account has, deleted ones included, without their payloads */
  fetchManifest(data: BaseData): Promise<ManifestEntry[]>

  /** Loads the given items. Items that don't exist are left out. */
  fetchByIds(data: BaseData & { itemIds: ItemId[] }): Promise<VaultItem[]>

  /** Stores sync messages, each under its own item */
  pushSyncMessagesBatch(input: PushSyncMessagesInput): Promise<void>

  /**
   * Returns an item's messages with a cursor after `fromCursor`, in pages. Pass a page's
   * `nextPageToken` back as `pageToken` (with the same `fromCursor`) to get the next page. Throws
   * `InvalidPageTokenError` for a token this driver didn't issue for this item, or one that
   * starts before `fromCursor`.
   */
  getSyncMessages(input: GetSyncMessagesInput): Promise<SyncMessagesPage>

  /**
   * Throws `InvalidPageTokenError` if the matching query would reject `pageToken`: the per-item
   * query when `itemId` is given, otherwise the account-wide one. Lets callers reject a request
   * before acting on any of it.
   */
  validatePageToken(input: ValidatePageTokenInput): void

  /**
   * Returns the account's messages with a cursor after `cursor`, across items, in pages. Paging works
   * as in `getSyncMessages`, except that a token is not checked against `cursor`.
   */
  getGlobalSyncMessagesAfterCursor(input: GetGlobalSyncMessagesInput): Promise<GlobalSyncMessagesPage>
}
