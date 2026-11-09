# Local Encryption at Rest

Two changes protect data at rest. **Part 1** derives the password key with Argon2id and takes data off password-derived keys (account level 2). **Part 2** seals the vault's local data, so someone with access to the device can't read it while the app is locked or closed (device level 3). Part 1 had to come first: Part 2 wraps its device key with the active data key, which on older accounts was derived from the original password.

## Goals

- No user content (documents) or user settings (the index document) is written to local storage unencrypted.
- No live data is encrypted with a key derived from a password.
- Unlocking needs the same secret as before (password or biometric), with no new prompt.
- Local data survives password changes and key rotation on any device without re-encrypting it.
- Migration is automatic and crash-safe, and loses no unpushed changes. No automatic step ever discards local data.
- The design lives in the library (`@vault/client`). Flock only opts in and picks storage names.

## Local storage

| Store | Contents | Protection |
|---|---|---|
| Sealed Automerge database (`sealedAutomergeDatabase` + account) | Every document's full history; the wrapped DSK and upgrade marker in its `meta` store | Sealed |
| Sync metadata: `indexDocSealed` | Active and tombstoned item IDs, local-only settings, last sync times | Sealed |
| Sync metadata: other keys | Cursors, heads, versions, device data level | Plaintext, no user content |
| Sync log database (`syncLogDatabase` + account) | Pending marks, first-start records, snapshot rechecks and unconfirmed pulls (IDs, heads and counters), and parked entries | Needs no seal: parked entries hold the server's ciphertext as it arrived, and a plaintext session uses the same store |
| Manual recovery (`manualRecoveryDatabase` + account) | Item IDs and error reasons | Plaintext, no user content |
| Keyring cache, biometric data (localStorage) | Data keys | Encrypted (master key / WebAuthn PRF) |
| Account metadata (localStorage) | Account ID, salt, key derivation parameters | Plaintext, needed before login |
| Plaintext Automerge database, `indexDoc`, WALs (plaintext and sealed) | Left by older builds | Retired by the upgrade; WALs are never read and are cleared at first start (sync-design.md) |

The session token is kept only in memory (see "Session tokens").

## Non-goals and limits

- **An unlocked session.** While the app is unlocked, the keys are in memory, and anything running in the origin (XSS, a malicious extension, DevTools) can read the data.
- **Offline password guessing.** The keyring cache is wrapped with the password-derived master key, so local data is exactly as strong as the password and the key derivation. Argon2id raises the cost of guessing but can't remove it.
- **A tampered app.** An attacker who can change the app's code or service worker cache can capture the password at the next unlock. For the same reason, the associated data on sealed records stops records being mixed up, not tampering by someone who can also replace the app.
- **Forensic remnants.** Deleting the plaintext database doesn't securely erase the disk. Full-disk encryption is the only mitigation.
- **Storage keys and sync bookkeeping.** Automerge storage keys (document IDs plus content hashes) stay readable, because range queries need them, so the number of items and roughly when each changed can be read. Cursors, heads, versions and recovery reasons hold no user content.
- **Ciphertext that already existed under v1.** `FlockSyncMessages` rows until they expire, DynamoDB backups, and backup files downloaded before the migration stay under the password-derived v1 key, and can be brute-forced at PBKDF2 cost against the *original* password. That's why the migration requires a new password.
  - **Deleted items** kept their last snapshot under v1, because re-encryption walks only the active index and the `passwordDerivedDataKey` blocker ignores deleted items. The `dropDeletedItemPayloads` server migration (`src/vault/migrations/deletedItemPayloads.ts`) removes the snapshot and any `cipher` from deleted rows, keeping `metadata`, `deleted`, `version` and `modifiedAt`, so the manifest doesn't change. It doesn't wait for a level to be retired, because nothing reads a deleted item's content. Run `countDeletedItemPayloads` first; both are idempotent. Items deleted later upload their deletion under whatever key is active then, so it needn't run again.
- **Auto-lock** defaults to 10 minutes of inactivity (`DEFAULT_AUTO_LOCK_SETTINGS`). The default isn't written to storage, and users can choose `never`.

## Part 1: Argon2id and random data keys

### Why a password change alone wasn't enough

Accounts used to derive the master key with PBKDF2, and **data key v1 was the password-derived key itself**: the keyring was seeded with `['1', derivedKey]`. A password change re-wraps the keyring under a new master key but keeps every data key. So, unless the account had rotated, every snapshot was encrypted with PBKDF2(*original password*):

- **Old passwords stayed live** against anyone with ciphertext (a server breach, a DynamoDB backup, a copied profile).
- **Anything under v1 can be brute-forced at PBKDF2 cost**, whatever the current key derivation is. Moving to Argon2id buys nothing for data still under v1.
- **The original iteration count and salt still counted**, because login upgrades re-wrap only the master key.

So the migration both **changes the password with Argon2id** and **rotates to a random data key and re-encrypts everything**.

### Parameters

| Parameter | Value | Notes |
|---|---|---|
| Algorithm | Argon2id, version 0x13 | Resists both GPU guessing and side channels |
| Memory | **64 MiB** | RFC 9106's recommendation for memory-constrained use, above OWASP's minimums |
| Passes | **3** | RFC 9106's pairing for 64 MiB |
| Lanes | **1** | WASM in the browser is single-threaded, and lanes don't change total work |
| Salt | 16 random bytes | `generateSalt` |
| Output | 32 bytes | The AES-GCM-256 master key. The auth token is `SHA-512(master key)` |

- **The client chooses; the server only stores.** The defaults are client constants (`getDefaultKdf()`). The client applies them when it creates an account or changes a password, and sends them with the salt. The server keeps them on the account record (`kdf`) so a device can derive the key before it has anything else, and validates only their shape: a server-side minimum would be a check a compromised server could skip.
- **So the client checks what it reads back,** from `getSecurityParams` or from local metadata. Otherwise an altered record (`m=8 KiB, t=1`) would make the next login send an auth token that's cheap to brute-force. The client refuses parameters below the floor with `UnsupportedKeyDerivationError` (each of memory, passes and lanes at least the defaults, since nothing has written weaker ones; the floor stays put if the defaults rise) and above a ceiling, so an altered record can't make every login allocate gigabytes. PBKDF2 paths refuse fewer than 100,000 iterations, the weakest value Flock wrote.
- **Raised at login.** Login re-wraps when the stored Argon2id parameters or salt version are below the current ones (`needsKeyDerivationUpgrade`).
- **Unknown accounts.** `getSecurityParams` returns fake parameters for unknown accounts (`unknownAccountParams`, configured in `src/vault/api/index.ts` from the `UNKNOWN_ACCOUNT_SECRET` SST secret) with the current `kdf`, so the response doesn't reveal whether an account exists. A mistyped account ID fails like a wrong password, after a full key derivation.
- **Off the main thread.** WebCrypto has no Argon2, so `hash-wasm` runs it. `VaultHostHooks.createKdfWorker` creates a worker that calls `exposeKdfWorker` (`@vault/client/kdfWorker`), one per derivation, terminated afterwards so the 64 MiB is released. Biometric unlock skips derivation.

### Format

- **`kdf` on the account record** (`{ algorithm: 'argon2id', memoryKiB, passes, parallelism }`). Absent means PBKDF2 with `iterations`. New credentials are always Argon2id: `createAccount` requires `kdf` and `changePassword` requires `newKdf`, and neither accepts an iteration count, since a PBKDF2 password change would leave an Argon2id `kdf` beside PBKDF2 credentials.
- **`randomDataKeys: true`** is set by `createAccount`, which also requires the keyring, so new accounts start with a random v1 at the current level. Without the flag, `kver === '1'` can't tell a derived v1 from a random one. A legacy account with `keyringVersion > 1` has rotated off v1.
- **PBKDF2 is a host hook** (`VaultHostHooks.deriveLegacyKey`, returning the key bytes so the library still decides the key's properties). Only the migration app passes it (`src/migrate/legacy/keyDerivation.ts`), so the main app can't derive a PBKDF2 key. An offline login with a PBKDF2 cache is told it needs the server; biometric unlock still works.
- **The master key enters the keyring only on PBKDF2 accounts,** where v1 really is the master key. On Argon2id accounts, a login or biometric unlock that ends with an empty keyring fails rather than unlocking keyless, and a missing server keyring is an error.
- **After any password change,** biometric unlock on another device fails because its saved master key is stale. When the server rejects that key (401, not a network error), `unlockWithBiometrics` clears the biometric data and the cached keyring and throws `StaleBiometricKeyError`, and the login page asks for the password.

### Routing

Level 2 has no device or hydrator gate, so the main app routes accounts to `/migrate/` from the login page and after every unlock (see "Backwards compatibility" in [vault-extraction.md](vault-extraction.md)).

- **The main app never derives a key from PBKDF2 parameters the server sent.** It routes any account the server describes without `kdf`, whatever its level. Otherwise a server could describe an Argon2id account as PBKDF2 and get an auth token far cheaper to guess from.
- **Pinned on the device.** If local metadata says the account is Argon2id, the migration app refuses PBKDF2 parameters from the server (`KeyDerivationDowngradeError`). A device that has never logged in can't pin; the PBKDF2 floor bounds what a server can gain there.
- **Split minimums.** Level 2 has no device-side work, so without separate `MIN_DEVICE_DATA_VERSION` and `MIN_ACCOUNT_DATA_VERSION` every other device would go through `/migrate/` for no reason.

### Migration (in the migration app)

Blockers: `legacyKeyDerivation` when `kdf?.algorithm !== 'argon2id'`, and `passwordDerivedDataKey` when the account lacks `randomDataKeys` and either v1 is still active (`keyringVersion` ≤ 1) or any live item's snapshot has `kver` `'1'` (or none). `listItemFormats` projects `snapshot.kver` for this.

**Each step is chosen from the account's current state, never from a flag on this device,** so the flow resumes correctly after an interruption on any device:

| Account state (from the server and the loaded keyring) | Next step |
|---|---|
| No Argon2id `kdf` | 1. New password, then 2. password change |
| Argon2id, active key is `'1'` | 3. Rotate, then re-encrypt |
| Rotated, `passwordDerivedDataKey` still reported | 3. Re-encrypt only |
| No blockers | 4. Raise the level and return |

1. **Ask for a new password.** It must differ from the current one (the old password's PBKDF2 output exists in old backups), meet the strength floor (zxcvbn score 3, `MIN_PASSWORD_STRENGTH`) and be typed twice. The user confirms the consequences first: other devices sign out, biometric unlock must be set up again, an offline device unlocks with the old password until it's next online, and **a forgotten password can't be recovered**.
2. **Change the password with Argon2id** (`rewrapMasterKey`), which re-wraps the whole keyring, signs out other sessions, clears biometric data and broadcasts `PASSWORD_CHANGED`. **This comes before rotation**, so that signed-out devices stop writing v1 snapshots during re-encryption, and the new random key never lands in a cache wrapped under the old PBKDF2 password.
3. **Rotate and re-encrypt** once sync has settled, while the server still reports `passwordDerivedDataKey` or `unboundSnapshots`. Rotate only for `passwordDerivedDataKey`; `reencryptAllItems` adds a random key, makes it active and re-encrypts with a progress view. Items that can't be re-encrypted keep v1, go to manual recovery and keep the blocker; the main app's data recovery dialog can recreate oversized ones under a new ID.
4. **Raise the account level.** Poll `checkDataVersion` until the server has raised it, then return to `/`.

**Deferral** is offered only once step 2 has completed. Before that, the main app can't log the account in, so deferring would loop straight back to `/migrate/`.

**v1 stays in the keyring permanently.** It's wrapped under the Argon2id master key, and it's still needed for log rows until their TTL, backup files made before the migration (`importData` decrypts by `kver`) and any device-key wrap that predates Part 2's guard. Removing it would need every account's password, because the server can't edit an encrypted keyring.

## Part 2: local encryption

### Key hierarchy

```
password ──Argon2id──► master key ──wraps──► keyring (data keys v1..vN)   [localStorage + server]
                                                   │
                                      a random data key wraps
                                                   ▼
                                      device storage key (DSK)            [sealed database, meta store]
                                                   │
                                            AES-GCM seals
                                                   ▼
                                Automerge chunks, index document
```

- **Device storage key (DSK).** A random AES-GCM-256 key, one per account per device, never sent to the server. It's stored as `{ kver, iv, ct }`: the raw bytes encrypted with data key `kver` (plain encryption, since data keys are imported for `encrypt`/`decrypt` only). Unwrapping imports it as **non-extractable** and zeroes the buffer, which is defence in depth, not a boundary.
- **Never wrapped under a password-derived key.** A DSK is created only when the active data key is random: its version isn't `'1'`, or the account has `randomDataKeys`. The level isn't used, because an Argon2id account between migration steps 2 and 3 is still on a derived v1. `accounts.getKeyring` returns `randomDataKeys`, the device keeps it in its stored metadata (`hasRandomDataKeys`), and the main thread passes it to `initRepo`. Until then the device stays on plaintext storage. A server that falsely claims `randomDataKeys` gains no more than the keyring cache already gives, unless the password has changed since.
- **Wrapped with a data key, not the master key.** A password change leaves data keys unchanged, so the DSK is unaffected. Wrapping with the master key would strand the DSK on every other device after a password change, losing their unpushed changes.
- **Re-wrapped only on a deliberate rotation.** The keyring keeps every version, so an old wrap stays readable. `reencryptAllItems` ends by re-wrapping the DSK under the new active key (`SyncWorkerContext.rewrapDeviceKey`) under the local data lock. A failure is logged and leaves the old wrap.
- **Why not seal with the data key directly?** A separate key keeps frequent local writes off the data key's random-nonce budget, which every device and log row shares, and makes rotation cost one write.

### Sealed records

Each record is sealed with AES-GCM using a fresh 96-bit IV. The associated data names the store and binds the record to its account and position, as a JSON array so no two contexts can collide:

| Store | Associated data |
|---|---|
| DSK wrap | `["vault-local", 1, "dsk", accountId]` |
| Automerge record | `["vault-local", 1, "automerge", accountId, ...storageKey]` |
| Index document | `["vault-local", 1, "index", accountId]` |

A record moved to another key, store or account fails to decrypt. Records store raw bytes (`{ key, v: 1, iv, ct }`), because IndexedDB structured-clones typed arrays. Storage keys stay plaintext, since `loadRange`/`has` need them.

- **IndexedDB pitfall:** a transaction auto-commits once it has no pending requests at the end of a task, so awaiting WebCrypto inside one throws `TransactionInactiveError`. Seal *before* opening the write transaction, and open *after* the read transaction completes. `loadRange` collects the raw records, then decrypts them with `Promise.all`.
- **A record that fails to decrypt throws. It's never treated as missing.** Returning `undefined` or skipping a chunk would make a present document look absent or silently drop history while `has()` still reports it, and automerge-repo only tracks chunks that loaded, so a later compaction could remove a skipped one.
  - automerge-repo's `StorageSource` loads without a `catch`, so a rejected load would leave the handle pending forever. Instead the sealed codec reports each failure (`onOpenFailure`): the context quarantines the document once as `localDecryption`, and `AutomergeDocStore` gives up on it at once.
  - **Recovery:** "Replace from server" (`replaceFromServer`) drops the document's local chunks and stuck handle, forces a manifest sync and unquarantines the item once the server's copy is stored. The user confirms first, since unsynced changes to it are lost.

### New databases, not in-place rewrite

Sealed data goes into **new databases** (`sealedAutomergeDatabase`, created at version 1 with `documents` and `meta` stores) and the sealed index goes under a **new key** (`indexDocSealed`):

- **Old builds aren't broken by the format change.** A tab on a cached older build keeps using the plaintext stores. An in-place rewrite would make it see records without `binary` as missing while `has()` says they exist, which trips the `hasDataInStorage` guard, and a sealed value under `indexDoc` would look like no index, so it would save an empty one.
- **Crash safety is simple.** The plaintext copy stays intact until the sealed copy is complete and marked.

Existing names never change. These are additions.

### Opening local storage before the Repo

The Repo reads `storage-adapter-id` as soon as it exists, so the upgrade can't run lazily inside the adapter: lookups would hit their timeouts during a long copy, `hasLocalData` would be decided before the plaintext index was merged (recording a plaintext device as new at the current level), the quota fallback must pick an adapter first, and the lock would nest. So `SyncWorkerContext` creates the Repo and its components in `initialize()`, after `openLocalStorage()`:

```
initialize():
  checkDeviceDataVersion()          // either index key; no DSK needed
  under localDataMigrationLock:     // one acquisition, not nested
    migrateLocalData hook
    openLocalStorage()              // load or create the DSK, run the upgrade, pick the adapter
  create Repo and components
  hasLocalData = index exists
  lifecycle.start()
```

**Loading the DSK:** unwrap it if `meta` holds one. If `meta` has none and `documents` is empty, generate one and `add` it in its own transaction (on `ConstraintError` another tab won, so re-read). If `meta` has none but `documents` isn't empty, raise `LocalKeyUnavailableError`: a new key would make every existing record unreadable.

### Upgrade (copy and seal)

`LocalEncryptionUpgrade` (opt-in through `SyncWorkerConfig.upgradeLocalEncryption`) runs on every start inside `openLocalStorage()`. It's a cheap check when nothing plaintext remains, and a merge if an old-build tab wrote to the plaintext stores since.

1. **Detects plaintext data** with `databaseExists`, which never creates a database, or the plaintext `indexDoc` key.
2. **Copies the Automerge records** in pages, sealing outside the transaction. Only `snapshot` and `incremental` chunks are copied: their keys are content hashes and the Repo merges every chunk it loads, so the copy is idempotent and resumes after a crash. `storage-adapter-id` is copied only on the first import, and `sync-state` records are skipped.
3. **Leaves the WAL alone.** Nothing reads it.
4. **Merges the plaintext `indexDoc` into `indexDocSealed`** with `mergeIndexDocuments`, the union backup import uses: deletions from either side win, and the sealed side's settings win. The tombstone list is how the engine refuses to resurrect deleted items, so a lost index is a correctness problem as well as a privacy one.
5. **Writes `{ upgradedAt }`** to the sealed `meta` store.
6. **Retires the plaintext stores** (below). If it can't yet, the upgrade still counts as done, and the next start re-imports anything new and tries again. `retireLegacyStores` removes the plaintext `indexDoc` only after deleting the Automerge database and the WAL, so a deletion that times out keeps `retired` false.

**Failure handling:**
- **Quota error mid-copy:** keep the partial sealed data, warn and retry next start. Before the first copy has finished, the session runs on the plaintext adapter (the only complete copy); after it, the session stays sealed.
- **DSK can't be unwrapped** (a `kver` missing from this tab's keyring, a corrupted record, tampering): raise `LocalKeyUnavailableError`. **The data is never reset automatically.** The worker emits `localDataUnavailable { kver, unpushedChanges }`, the main thread fetches the missing key and the init retry exports the keyring again. A second failure in a row stops sync and calls `SyncStateSink.onLocalDataUnavailable`. Flock's `LocalDataUnavailableDialog` offers "Try again" and a confirmed "Discard local data and download from the server", stating how many changes are unpushed (counted from pending marks, readable without the DSK).

### Retiring the plaintext stores

Deleting a database under a live old-build tab is unsafe: it reconnects to a fresh empty database, sees no items and saves an empty index. So before deleting the plaintext databases and `indexDoc`:

1. **Check whether anything else is using the account.** `navigator.locks.query()` lists holders of, and waiters for, the account's `leaderLock` and `indexLock`, which every build holds (the names are pinned). This engine hasn't requested them yet. Without Web Locks, nothing is deleted.
2. **If so, ask other tabs to stop.** The worker emits `retiringLegacyStores`, and the app's `SyncStateSink.beforeRetiringLegacyStores` posts `{ type: 'started' }` on `MIGRATION_CHANNEL`, which every build since level 1's extraction locks on. The main thread posts on the channel object it listens with, because a `BroadcastChannel` never delivers to its sender, so the upgrading tab doesn't lock itself.
3. **Delete, or wait for the next start.** Once nothing else holds the locks (it waits up to 5 s), delete. Otherwise, or if a deletion is blocked, retry on the next start.

### Data levels

- **`FLOCK_DATA_VERSION` 3, `MIN_DEVICE_DATA_VERSION` 3.** The device gate sends a device below 3 with local data to `/migrate/` before its worker starts, and `hasLegacyLocalData` also reports the plaintext Automerge and WAL databases. The migration app seals the data, so nothing is lost.
- **Both workers seal** (`upgradeLocalEncryption: true`). The main app needs it to seal a new device and to merge plaintext an old tab wrote since. The migration app needs it too, or after the main app retired the plaintext stores it would find them empty and download everything into plaintext again.
- **Both pass `sealedDataVersion: 3`,** so `DataVersionTracker` records at most 2 until the session is sealed with no plaintext stores left. The quota fallback and the password-derived-key guard never record level 3.
- **A device that can't seal** (an account still on a derived v1) stays below 3 until the migration app rotates the account's key.
- **Retiring the level:** the server can't see device levels, so there's no scan to wait for. Keep the upgrade, or replace it with "discard local data and download from the server" (losing unsynced changes) once that's accepted.

### Cleanup paths

Every path that removes local data must include the sealed databases: `clearAccountLocalData` / `localDataCleanup.ts`, `ServiceLifecycleManager` (the Repo shuts down before its database is cleared, rule 5), `clearWriteAheadLog`, `clearSyncLogStorage` and `removeVaultFromDevice`.

### Testing

`cypress/e2e/local-encryption.cy.ts` checks that, once sync has stopped, every sealed record has the sealed shape, no plaintext databases or `indexDoc` remain, and a person's name appears in no IndexedDB database, localStorage key or Cache Storage entry. Automerge DEFLATE-compresses larger columns, so that search only proves anything if a short name appears verbatim in unencrypted chunks, which `src/app/vault/localEncryptionControl.spec.ts` checks.

## Session tokens

A session token can't read anything without the keys, but it can make authenticated writes: soft-delete every item with payload-less tombstones, overwrite snapshots, or upload a garbage keyring that locks every device out. So:

- **The token is kept only in memory** (each realm's `setApiAuthToken`). Every unlock gets a new session and passes it to the sync worker (`initRepo`, `updateAuthToken`). Unlocking and locking delete `authDatabase`, where earlier builds stored it.
- **The server stores only hashes of tokens** (`hashSessionToken`) and rejects records that hold a raw one.
- **Sessions last 72 hours** (`SESSION_EXPIRY_MS`). Unlocked clients re-establish an expired session silently from the key hash.
- **Keyring uploads prove the master key.** `accounts.updateKeyring` requires `currentAuthToken`, as `changePassword` does.
- **Still open:** a token taken from a running, unlocked app works until it expires. Fixing that needs writes the server or other devices can authenticate, such as signatures from a key in the keyring.
