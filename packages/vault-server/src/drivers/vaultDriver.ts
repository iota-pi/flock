import type { z } from 'zod'

import type {
  ItemId,
  KdfParams,
  ManifestEntry,
  PageToken,
  SyncLogEntry,
  SyncLogMessage,
  VaultSessionRecordSchema,
  VaultAccountSchema,
  VaultAccountWithAuthSchema,
  VaultItemSchema,
  StoredSyncMessageSchema,
} from '@vault/shared'
import type { FailedLoginRecord } from '../loginThrottle'

export type VaultSessionRecord = z.infer<typeof VaultSessionRecordSchema>
export type VaultAccount = z.infer<typeof VaultAccountSchema>
export type VaultAccountWithAuth = z.infer<typeof VaultAccountWithAuthSchema>
export type VaultItem = z.infer<typeof VaultItemSchema>
export type StoredSyncMessage = z.infer<typeof StoredSyncMessageSchema>
/** An item as `fetchByIds` returns it, with any snapshot ciphertext as base64 */
export type FetchedVaultItem = Omit<VaultItem, 'snapshot'> & {
  snapshot?: Omit<NonNullable<VaultItem['snapshot']>, 'cipher'> & { cipher?: string }
}
/** An account record as stored, before its credentials are checked (see authentication.ts) */
export type StoredAccount = VaultAccount & FailedLoginRecord

export interface BaseData {
  account: string,
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
  /** Leaves out messages with a higher cursor, which may not have settled (docs/sync-design.md) */
  throughCursor?: number
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
  /** Leaves out messages with a higher cursor, which may not have settled (docs/sync-design.md) */
  throughCursor?: number
  pageToken?: PageToken
}

export interface GlobalSyncMessagesPage {
  items: Array<{ itemId: ItemId, messages: StoredSyncMessage[] }>
  hasMore: boolean
  nextPageToken?: PageToken
  /** The highest cursor the page examined */
  scannedThroughCursor: number
}

export interface AppendLogInput {
  account: string
  messages: SyncLogMessage[]
}

/** Where a message landed in the account's log */
export interface LogPushResult {
  itemId: ItemId
  seq: number
}

export interface ReadLogInput {
  account: string
  /** Returns rows strictly after this seq */
  after: number
}

export interface SyncLogPage {
  entries: SyncLogEntry[]
  hasMore: boolean
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
  fetchByIds(data: BaseData & { itemIds: ItemId[] }): Promise<FetchedVaultItem[]>

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

  /**
   * Appends messages to the account's log, in order, and reports each one's seq. Seqs are contiguous
   * and commit in order. A push too big for one transaction becomes several in a row, so another
   * device's rows can fall between them, and a failure can leave the earlier ones committed. Clients
   * resend a push that fails, which only delivers changes twice.
   */
  appendLog(input: AppendLogInput): Promise<LogPushResult[]>

  /** Returns the account's rows after a seq, oldest first, in one strongly consistent page */
  readLog(input: ReadLogInput): Promise<SyncLogPage>

  /** Returns the last seq the account's log has used, by a strongly consistent read (0 when it's empty) */
  readLogHead(data: BaseData): Promise<number>
}
