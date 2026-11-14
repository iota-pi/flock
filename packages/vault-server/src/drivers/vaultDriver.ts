import type { z } from 'zod'

import type {
  ItemId,
  KdfParams,
  ManifestEntry,
  SyncLogEntry,
  SyncLogMessage,
  VaultSessionRecordSchema,
  VaultAccountSchema,
  VaultAccountWithAuthSchema,
  VaultItemSchema,
} from '@vault/shared'
import type { LoginAttemptReservation } from '../loginThrottle'
import type { SignupReservation } from '../signupThrottle'

export type VaultSessionRecord = z.infer<typeof VaultSessionRecordSchema>
export type VaultAccount = z.infer<typeof VaultAccountSchema>
export type VaultAccountWithAuth = z.infer<typeof VaultAccountWithAuthSchema>
export type VaultItem = z.infer<typeof VaultItemSchema>
/** An item as `fetchByIds` returns it, with any snapshot ciphertext as base64 */
export type FetchedVaultItem = Omit<VaultItem, 'snapshot'> & {
  snapshot?: Omit<NonNullable<VaultItem['snapshot']>, 'cipher'> & { cipher?: string }
}
/** An account record as stored, before its credentials are checked (see authentication.ts) */
export type StoredAccount = VaultAccount & {
  /** Hashes of the account's login device tokens, earliest first (see loginDevices.ts) */
  loginDevices?: string[]
}

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
  /** Replaces the account's login devices (see loginDevices.ts) */
  loginDevices?: string[],
  keyringVersion?: number,
  expectedKeyringVersion?: number,
  /** App fields to delete from the account record, such as a sparse index's key */
  remove?: string[],
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

export interface AppendLogInput {
  account: string
  messages: SyncLogMessage[]
  /**
   * Most bytes of messages the account may append per UTC day. A push that would pass it throws
   * `QuotaExceededError` and appends nothing (from that transaction on, for a push of several).
   */
  maxBytesPerDay?: number
}

/** Where a message landed in the account's log */
export interface LogPushResult {
  itemId: ItemId
  seq: number
}

/** What writing an item did */
export interface SetItemResult {
  /** The version the write gave the item */
  version: number
  /** How many bytes the write added to the account's stored items (negative when it shrank them) */
  storageDelta: number
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

  /**
   * Counts a login attempt against an account ID before its password is checked, unless the ID is
   * locked, with one conditional write. Returns the reservation, or undefined when the ID is locked
   * and nothing was counted. IDs with no account are counted too, so that they lock as real ones do.
   */
  reserveLoginAttempt(data: BaseData): Promise<LoginAttemptReservation | undefined>

  /** Uncounts a reserved attempt whose password was right */
  releaseLoginAttempt(data: BaseData & LoginAttemptReservation): Promise<void>

  /**
   * Counts a sign-up against a network's row for the window (see signupThrottle.ts), unless the
   * window has used up its sign-ups, with one conditional write. Returns false when it has, and
   * nothing was counted.
   */
  reserveSignup(data: SignupReservation): Promise<boolean>

  /** Forgets one of the account's login devices (see loginDevices.ts). Does nothing if it isn't one. */
  removeLoginDevice(data: BaseData & { device: string }): Promise<void>

  /**
   * Updates the given account fields, leaving the others as they are. Apps can store their own
   * fields on the account record by passing them via `TExtra`. Throws `AuthenticationError` when
   * the account doesn't exist, and `VersionConflictError` when `expectedKeyringVersion` is given
   * and doesn't match.
   */
  updateAccountData<TExtra extends object = Record<never, never>>(
    data: UpdateAccountDataParams & Partial<TExtra>,
  ): Promise<void>

  /**
   * Adds a session to an account, keeping its other active sessions (called on login). `device` is
   * the hash of the logging-in device's token, which is added to the account's login devices.
   */
  addSession(data: AuthData & { expiry: number, device?: string }): Promise<void>

  /** Extends a session's expiry (called on authenticated requests) */
  extendSession(data: AuthData): Promise<void>

  /** Raises the account's data version. Never lowers it. */
  raiseDataVersion(data: BaseData & { dataVersion: number }): Promise<void>

  /** Describes how each of the account's items is stored, without loading their payloads */
  listItemFormats(data: BaseData): Promise<ItemFormatSummary[]>

  /** Writes an item. Callers add its `storageDelta` to the account's usage with `addStorageUsage`. */
  set(item: VaultItem): Promise<SetItemResult>

  /** Adds `bytes` (which may be negative) to the account's `storageBytes` */
  addStorageUsage(data: BaseData & { bytes: number }): Promise<void>

  /**
   * Counts how many bytes the account's items take up and stores that as its `storageBytes`,
   * correcting any drift. It reads every item, so it's for migrations, not requests.
   */
  recountStorageUsage(data: BaseData): Promise<number>

  /** Lists every item the account has, deleted ones included, without their payloads */
  fetchManifest(data: BaseData): Promise<ManifestEntry[]>

  /** Loads the given items. Items that don't exist are left out. */
  fetchByIds(data: BaseData & { itemIds: ItemId[] }): Promise<FetchedVaultItem[]>

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
