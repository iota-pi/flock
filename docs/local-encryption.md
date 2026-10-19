# Local Encryption at Rest

Design and implementation plan for two changes. **Part 1** moves password key derivation from PBKDF2 to Argon2id and takes data off password-derived keys. **Part 2** encrypts the vault's local data, so someone with access to the device can't read it while the app is locked or closed. Status: Part 1 **implemented, not yet released**; Part 2 **proposed**.

**Part 1 ships first.** Part 2 wraps its device key with the active data key. On every account created so far, that key is derived from the original password (see "Why a password change alone isn't enough"). Shipping Part 2 first would leave local data only as strong as PBKDF2 of a password the user may have changed long ago.

## Problem

The server only ever sees ciphertext, but the device stores plaintext:

| Store | Contents | Today |
|---|---|---|
| Automerge database (`automergeDatabase` + account) | Every document's full history | **Plaintext** (`VaultIndexedDBStorageAdapter` writes raw chunks) |
| WAL (`walDatabase` + account) | Outbound sync messages not yet pushed | **Plaintext** `data` |
| Sync metadata: `indexDoc` | Active and tombstoned item IDs, local-only settings (`sortCriteria`), last sync times | Plaintext |
| Sync metadata: other keys | Cursors, heads, versions, device data level | Plaintext, no user content |
| Manual recovery (`manualRecoveryDatabase` + account) | Item IDs and error reasons | Plaintext, no user content |
| Keyring cache, biometric data (localStorage) | Data keys | Encrypted (master key / WebAuthn PRF) |
| Session token (`authDatabase`) | Bearer token | Plaintext, cleared on lock |
| Account metadata (localStorage) | Account ID, salt, key derivation parameters | Plaintext, needed before login |

Locking forgets the keys and shuts the worker down (`lockVault` in `src/app/vault/session.ts`), but anyone who can read the browser profile (DevTools on a shared machine, malware, a copied profile or backup, a stolen unencrypted disk) can parse the Automerge database without the password.

## Goals

- No user content (documents, WAL messages) or user settings (the index document) is written to local storage unencrypted.
- No live data is encrypted with a key derived from a password.
- Unlocking needs the same secret as today (password or biometric). There's no new prompt.
- Local data survives password changes and key rotation on any device without re-encrypting it.
- Existing devices migrate automatically, crash-safely and without losing unpushed changes. No automatic step ever discards local data.
- Offline unlock keeps working through the migration.
- The design stays in the library (`@vault/client`). Flock only opts in and picks storage names.

## Non-goals and limits

- **An unlocked session.** While the app is unlocked, the keys are in memory and anything running in the origin (XSS, a malicious extension, DevTools) can read the data. Encryption at rest doesn't change that.
- **Offline password guessing.** The keyring cache is wrapped with the password-derived master key, so local data is exactly as strong as the password and the key derivation. An attacker with the profile can brute-force a weak password offline. Part 1 raises the cost but can't remove it.
- **A tampered app.** An attacker who can change the app's code or service worker cache can capture the password at the next unlock. For the same reason, sealed records don't defend against a local attacker who can write to storage. The associated data stops records being mixed up, not tampering by someone who can also replace the app.
- **Forensic remnants.** Deleting the plaintext database after migration doesn't securely erase the disk. Old pages can survive until the browser's storage engine compacts them. Full-disk encryption is the only mitigation.
- **Storage keys and sync bookkeeping.** Automerge storage keys (document IDs plus content hashes) stay readable, because range queries need them. So the number of items and roughly when each changed can still be read. Cursors, heads, versions, WAL entry descriptors and manual recovery reasons stay plaintext, since they hold no user content.
- **Ciphertext that already exists under v1.** Sync messages (for up to 90 days), DynamoDB backups and backup files the user downloaded before the migration stay encrypted with the password-derived v1 key. They can be brute-forced at PBKDF2 cost against the *original* password. That's why the migration requires a new password.
  - **Deleted items keep theirs indefinitely.** A deleted item's row keeps its last real snapshot, and re-encryption only walks the active index (`listAutomergeItemIds`), which leaves tombstones out. The `passwordDerivedDataKey` blocker ignores deleted items too, so the migration finishes with their content still under v1 on the server and in its backups. Anyone who gets that data can still guess the original password at PBKDF2 cost and read what was deleted.
  - **Follow-up:** deletion is terminal and deleted content is never read again, so a server migration can drop the snapshot payload of deleted items, keeping `metadata.deleted` and the version. It belongs with the destructive cleanups that run when level 2 is retired.

## Part 1: Argon2id and random data keys

### Why a password change alone isn't enough

Key derivation today is PBKDF2-HMAC-SHA256 at 600,000 iterations (`DEFAULT_CRYPTO_ITERATIONS`). `loginVault` already re-wraps accounts below that at their next online login (`needsKeyDerivationUpgrade`). PBKDF2 isn't memory-hard, though, so GPUs and ASICs guess it cheaply.

**Data key v1 is the password-derived key itself.** Two paths put the master key into the keyring as version `'1'`: `initialiseVault` and `unlockWithBiometrics` (`keyring.replace(new Map([['1', derivedKey]]), '1')`). At the account's first login the server has no keyring yet, so `syncKeyringFromServer` → `storeVault` uploads that keyring. `rewrapMasterKey` (password change) re-wraps the keyring under a new master key but keeps every data key. So unless the user has run "Re-encrypt vault" (`rotateVaultKey` + `reencryptAllItems`), every snapshot and sync message is encrypted with PBKDF2(*original password*). This has three consequences:
- **Old passwords stay live.** Changing the password today doesn't protect against someone who knows or cracks the original one and has ciphertext: a server breach, a DynamoDB backup or a copied profile.
- **Anything encrypted under v1 can be brute-forced at PBKDF2 cost**, whatever the current key derivation is. A move to Argon2id has to get live data off v1, or it buys nothing for that data.
- **The account's original iteration count still counts.** An account created with fewer iterations or a legacy salt keeps that weaker derivation in v1. Login upgrades only the master key, not v1.

So the migration is two parts: **change the password with Argon2id**, then **rotate to a random data key and re-encrypt everything**. The order matters (see "Migration").

### Parameters

| Parameter | Value | Notes |
|---|---|---|
| Algorithm | Argon2id, version 0x13 | Resists both GPU guessing and side channels |
| Memory (`m`) | **64 MiB** (65,536 KiB) | RFC 9106's recommendation for memory-constrained use. Above OWASP's minimums (19–46 MiB) |
| Passes (`t`) | **3** | RFC 9106's pairing for 64 MiB |
| Lanes (`p`) | **1** | WASM in the browser is single-threaded. `p` doesn't change total work, so more lanes only add complexity |
| Salt | 16 random bytes | `generateSalt`, as now |
| Output | 32 bytes | Imported as the AES-GCM-256 master key. The auth token stays `SHA-512(master key)` |

- **Decided:** these values are fixed, not subject to a benchmark. A rough estimate for 64 MiB / t=3 in WASM is 0.3–0.6 s on desktops and 0.6–2 s on phones (not measured). Step 1.1 records real timings, so a later release has data if it ever revisits them. Biometric unlock skips the derivation, so frequent unlocks with auto-lock on don't pay this cost.
- **The client chooses; the server only stores.** The parameters are constants in the client (`DEFAULT_KDF`, next to `DEFAULT_CRYPTO_ITERATIONS`). The client applies them when it creates an account or changes a password (`rewrapMasterKey`), and it sends them with the salt. The server never picks or adjusts them. It keeps them on the account record so a device can derive the key before it has anything else.
- **Where a device reads them from.** A device with nothing cached (a new device, or after "remove from device") can only get the salt and parameters from `getSecurityParams`. A device with cached metadata still prefers the server's answer when it arrives within `CACHED_PARAMS_WAIT_MS` (`Login.tsx`). Either way, the parameters the client derives with usually come from the server.
- **So the client checks what it reads back,** whether from `getSecurityParams` or from local metadata. This only matters if the stored copy can be altered: a compromised API or database, or a malicious operator, which is the threat model the doc-bound ciphertexts already assume ([sync-design.md](sync-design.md)).
  - **The attack:** the record is rewritten to `m=8 KiB, t=1`. The next login derives a cheap key and sends its auth token, and the attacker brute-forces the password from that token instead of paying the real cost.
  - **Floor:** refuse anything weaker than the weakest parameters any Flock release has written, with `UnsupportedKeyDerivationError`. For Argon2id that's 64 MiB / t=3 / p=1, the defaults, because nothing has written weaker ones. If a later release raises the defaults, the floor stays put, since older accounts legitimately keep the older parameters until their next login re-wraps them. The check is per parameter: memory, passes and lanes each at least the floor, and the algorithm exactly `argon2id`.
  - **Ceiling:** the client also caps what it will accept (for example 256 MiB and t ≤ 10). Otherwise an altered record could make every login allocate gigabytes and crash the tab on phones.
  - **PBKDF2:** every remaining PBKDF2 path refuses fewer than 100,000 iterations (`LEGACY_CRYPTO_ITERATIONS`, the weakest value Flock has written). Before shipping, check the minimum stored `iterations` in `FlockAccounts`. If any account has less, set the floor at the real minimum instead.
- **No server-side floor.** The server validates the shape of `kdf` (a known algorithm, positive integers) as ordinary input validation. It doesn't enforce a minimum. A minimum there would be a check on its own data that a compromised server could skip, so it adds nothing to security.
- **Fake parameters for unknown accounts.** The library's `getSecurityParams` can return fake parameters for unknown accounts (`unknownAccountParams`), so the response doesn't reveal whether an account exists. Once Argon2id is the default, the fakes must carry a `kdf` with the current defaults; otherwise a PBKDF2-shaped answer marks the account as nonexistent (or not yet migrated). `UnknownAccountParams` gains a `kdf` field. Flock doesn't configure fake parameters (unknown accounts get NOT_FOUND), so this only matters to other apps using the library.
- **Stored per account, raised at login.** Login re-wraps when the stored Argon2id parameters are below the current defaults, as `needsKeyDerivationUpgrade` does for iterations now.
- **Tests:** Cypress uses its own test parameters and floor, as `isCypress` does for iterations now.
- **Library.** `hash-wasm` (MIT, maintained, Argon2id in WASM), declared as a dependency of `@vault/client`. WebCrypto has no Argon2 yet. Derivation runs in a short-lived dedicated Worker, so the UI doesn't freeze and the 64 MiB is freed afterwards.

### Format

- **Account record and wire schemas** (`VaultAccountSchema`, `CreateAccountBodySchema`, `ChangePasswordBodySchema`, `getSecurityParams`) gain `kdf: { algorithm: 'argon2id', memoryKiB, passes, parallelism }`.
  - `kdf` absent means PBKDF2 with `iterations`.
  - The client sets `kdf`, and the server stores and returns it, validating only its shape.
- **`randomDataKeys: true` on the account record.** `createAccount` sets it for accounts created with a random v1. Without it, `kver === '1'` can't tell a legacy derived v1 from a new account's random v1.
  - **Legacy accounts don't need it set:** `storeVault` already sends the active key version as `keyringVersion`, so a legacy account with `keyringVersion > 1` has rotated off v1. The rotation needs no extra write.
- **`createAccount` takes the keyring.** `CreateAccountBodySchema` gains `keyring` (encrypted with the master key) and `kdf`.
  - **The server sets `dataVersion`** from the request, through the policy's `newAccountVersion` (it replaces `dataVersion` in `FLOCK_ACCOUNT_DEFAULTS`): the current level only when the request carries an Argon2id `kdf` and a keyring, otherwise 1. A cached old build that somehow creates a PBKDF2 account then still goes through the migration. `minProtocolVersion` already blocks this, but the server shouldn't depend on it.
- **`deriveVaultKey` branches on `kdf`.** PBKDF2 becomes a host hook, like `decodeLegacySalt`: `VaultHostHooks.deriveLegacyKey`, which returns the 32 key bytes so the library still decides the key's properties. While phase 1 lasts it lives in `src/app/vault/legacyKeyDerivation.ts` and both apps pass it, since the main app may import only `detection.ts` from `src/migrate/`. It moves to `src/migrate/legacy/` at phase 2, as level 1's code did.
- **Argon2id runs off the main thread.** `VaultHostHooks.createKdfWorker` creates a worker that calls `exposeKdfWorker` (from `@vault/client/kdfWorker`). Each derivation gets a fresh worker, terminated afterwards, so its 64 MiB is released.
- **The master key enters the keyring only on PBKDF2 accounts.** `initialiseVault` and `unlockWithBiometrics` seed `['1', masterKey]` only when the account has no `kdf`, where v1 really is the master key. On Argon2id accounts the keyring stays empty until it's loaded from cache or the server.
  - **No keys, no unlock:** a login or biometric unlock that ends with an empty keyring (no cache, keyring fetch failed) fails rather than unlocking keyless.
  - **Missing server keyring:** `syncKeyringFromServer` still seeds one for a PBKDF2 account (one that never stored its keyring), and treats it as an error for an Argon2id account, which is created with one.

### Compatibility (phase 1)

Following "Backwards compatibility" in [vault-extraction.md](vault-extraction.md), this is account level 2, shipped as a compatibility release before anything is removed.
- **Online password login** routes accounts below `MIN_ACCOUNT_DATA_VERSION` (2) to `/migrate/` before deriving keys, as `Login.tsx` does now. It also routes any account the server describes without `kdf`, whatever its level: **the main app never derives a PBKDF2 key from parameters the server sent**. Otherwise a server could describe an Argon2id account as PBKDF2 and get an auth token far cheaper to guess the password from.
- **Offline password login** (or a slow server, where `Login.tsx` uses the cached parameters) on a device whose cached metadata is still PBKDF2 unlocks with the PBKDF2 hook, subject to the 100,000-iteration floor.
  - **Why this is allowed:** after the release, every existing device's cache is PBKDF2 until its next online login, so refusing would lock offline users out of an offline-first app (even users whose account was already migrated on another device).
  - **Sessions are allowed:** the parameters came from the device, not the server, so the auth token is the account's real one. Biometric unlock already sends the same token. Nothing is re-wrapped, and the account-level check below sends the user to `/migrate/` once the device is online.
- **Account-level check after every unlock.** Once online, after a password *or biometric* unlock, the app calls `getSecurityParams` and, below the minimum and not deferred, locks and goes to `/migrate/`.
  - **Why biometrics needs it:** `handleClickBiometricUnlock` in `Login.tsx` skips the check today, and level 2 has no device or hydrator gate. Users who always unlock with biometrics would otherwise never be migrated.
- **The main app stops upgrading PBKDF2 at login.** The `needsKeyDerivationUpgrade` path that re-wraps PBKDF2 to PBKDF2 goes away. It would sign out other sessions for no lasting benefit.
- **Old builds.** A cached old build can't derive Argon2id keys. Raise `minProtocolVersion` in the same deploy: `login` and `createAccount` are mutations, so the gate in `trpc.ts` stops old builds at login and account creation and they update and reload.
- **Phase 2 (later):** once the account-level scan shows no accounts below 2 (or the rest are accepted as abandoned), stop passing the PBKDF2 hook in the main app and move it to `src/migrate/legacy/`. The migration app keeps it until level 2 is retired.
- **Release:** the server changes can deploy first. The client changes for new accounts and the forced migration must ship together: on their own, the new-account changes would leave the old login auto-upgrade re-wrapping legacy accounts to Argon2id with the *same* password, before the migration's password step exists.

### Migration (in the migration app)

- **Server policy** (`flockDataVersion.ts`), level 2:
  - `legacyKeyDerivation` is reported when `kdf?.algorithm !== 'argon2id'`.
  - `passwordDerivedDataKey` is reported when the account lacks `randomDataKeys` and either v1 is still active (`keyringVersion` ≤ 1) or any live item's snapshot has `kver` `'1'` (or none, which means `'1'`). For this, `listItemFormats` also projects `snapshot.kver`.
- **Pinned on the device.** If local metadata for the account says Argon2id, the migration app refuses PBKDF2 parameters from the server (`KeyDerivationDowngradeError`) rather than deriving a cheap key. A device that has never logged in to the account can't pin; the PBKDF2 floor bounds what a server can gain there.
- **Split Flock's minimum.**
  - **Worker:** `SyncWorkerConfig.minDataVersion` is the device gate, and level 2 has no device-side work, so Flock passes `MIN_DEVICE_DATA_VERSION` (1) to the worker.
  - **Login:** it checks `MIN_ACCOUNT_DATA_VERSION` (2).
  - **Migration app:** `isMigrationComplete` compares each level with its own minimum.
  - **Why:** without the split, every other device would go through `/migrate/` once for no reason.

**Each step is chosen from the account's current state, never from a flag on this device,** so the flow resumes correctly after an interruption on any device:

| Account state (from the server and the loaded keyring) | Next step |
|---|---|
| No Argon2id `kdf` | 1. New password, then 2. password change |
| Argon2id, active key is `'1'` (so `keyringVersion` is 1) | 3. Rotate (then re-encrypt) |
| Rotated, `passwordDerivedDataKey` still reported | 3. Re-encrypt only (no second rotation) |
| No blockers | 4. Raise the level and return |

1. **Ask for a new password.**
   - **Requirements:** it must differ from the current one, meet the existing strength floor (zxcvbn score 3, `MIN_PASSWORD_STRENGTH`, unchanged), and be typed twice.
   - **Why it must differ:** the old password's PBKDF2 output exists in old backups (auth token hashes, v1 ciphertext), so keeping it would leave it guessable at PBKDF2 cost.
   - **Explain the consequences up front,** and require confirmation:
     - Other devices sign out.
     - Biometric unlock must be set up again.
     - An offline device unlocks with the old password until it's next online.
     - **There is no recovery for a forgotten password** (encrypted backups need the keyring too, so they don't help). Suggest a password manager.
2. **Change the password with Argon2id.** `rewrapMasterKey` takes the new password and `DEFAULT_KDF`, and re-wraps the whole keyring.
   - **Done by the existing code:** it signs out other sessions, clears biometric data, re-establishes this tab's session and broadcasts `PASSWORD_CHANGED`.
   - **This comes before rotation.** Signing out the other devices first does two things:
     - **They stop writing v1 snapshots.** Online devices otherwise keep encrypting with v1 until a message under the new version makes them refresh their keyring (`keyVersionMissing` → `SyncBridge.handleKeyringUpdate`). A v1 snapshot written during re-encryption would keep the blocker set.
     - **The new random key never lands in a PBKDF2-wrapped cache.** A device that refreshed its keyring between a rotation and the password change would cache the new key wrapped under the *old* password, where a copied profile could crack it at PBKDF2 cost. Once signed out, a device can fetch the keyring only with the new password.
3. **Rotate and re-encrypt.**
   - **When:** once sync has settled (device level reached, sync idle) and the server still reports `passwordDerivedDataKey`, so every item is local first.
   - **Rotate:** while v1 is still active, the existing `reencryptAllItems(bridge, account)` flow adds a random key, makes it active (which raises `keyringVersion`) and re-encrypts. Once a random key is active, only the bridge's re-encryption runs.
   - **Re-encrypt:** run `reencryptAllItems` with a progress view (the `ReencryptVaultDialog` path).
   - **Resume:** an interruption resumes from the table above, not only via the per-device `REENCRYPT_PENDING_KEY_PREFIX` flag.
   - **Items that can't be re-encrypted** keep their v1 snapshot and keep the blocker set.
     - They go to manual recovery, and once sync settles the page shows the blocker. "Continue to Flock" (offered after step 2) defers the account, and the main app's data recovery dialog then offers `recreateOversizedItem` for oversized items, which moves them to a new ID under the new key.
4. **Raise the account level.** Poll `checkDataVersion` until the server has rescanned and raised it, then return to `/`.

**Deferral** ("Continue" with blockers left) is offered only once step 2 has completed. Before that, the main app can't log the account in online, so deferring would loop straight back to `/migrate/`.

**After the migration:**
- **v1 stays in the keyring permanently.** Keeping it is harmless: what matters is ciphertext under it, and the retained key is wrapped under the Argon2id master key. It's still needed for:
  - sync messages up to their 90-day TTL;
  - backup files made before the migration (`exportData` encrypts with the active key, and `RestoreBackupDialog` → `importData` decrypts by `kver`);
  - any device-key wrap that predates Part 2's guard.

  Removing it would also need every account's password, because the server can't edit an encrypted keyring.
- **Other devices.** Online, they log in with the new password, which fails to decrypt their stale cached keyring, so `loginVault` loads the server's keyring (existing behaviour). Offline, they unlock from the stale cache with the old password, as after any password change today. Their pushes then fail authentication until the user logs in again. WAL entries and snapshots are encrypted at push time with the then-active key, so nothing new is written under v1.

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
                                Automerge chunks, WAL message bytes, index document
```

- **Device storage key (DSK).** A random AES-GCM-256 key, one per account per device. It never leaves the device and is never sent to the server.
- **Stored as `{ kver, iv, ct }`:** the raw DSK bytes encrypted with data key `kver`. Data keys are imported with `encrypt`/`decrypt` only, so this is plain encryption, not WebCrypto `wrapKey`.
  - **Unwrapping** decrypts the raw bytes, imports them as a **non-extractable** key and zeroes the buffer. The raw bytes pass through JavaScript memory either way, so non-extractable is defence in depth, not a boundary.
- **Never wrapped under a password-derived key.** `LocalEncryptionUpgrade` refuses to create a DSK until the account is at level 2, so no live data key is password-derived. The main thread passes the account level it last saw from `getSecurityParams` to the worker with the keyring. The device then stays on plaintext storage (the phase 1 fallback) until the migration has rotated. After Part 1 this only affects accounts that deferred between the password change and a successful rotation. They're upgraded at the first start after the rotation completes.
- **Wrapped with a data key, not the master key.** A password change re-wraps the keyring but leaves the data keys unchanged, so the DSK is unaffected. Wrapping with the master key would strand the DSK on every other device: after a password change on device A, device B can't derive the old master key, so its unpushed local changes would be lost.
- **Re-wrapped only as part of a deliberate rotation.** The keyring keeps every version, so an old wrap always stays readable. Re-wrapping opportunistically on start would buy nothing and could race a tab whose keyring is older. `reencryptAllItems` re-wraps the DSK under the new active key as its last step, holding the local storage lock, with a session and a fresh keyring.
- **Why not seal with the data key directly?** A separate key keeps local writes off the data key's AES-GCM random-nonce budget. That budget is shared by every device and every sync message, and Automerge saves often. It also makes rotation cost one write instead of a full rewrite.

### Sealed records

Each record is sealed with AES-GCM using a fresh 96-bit IV. The associated data names the store and binds the record to its account and position, encoded as a JSON array so no two contexts can collide:

| Store | Associated data |
|---|---|
| DSK wrap | `["vault-local", 1, "dsk", accountId]` |
| Automerge record | `["vault-local", 1, "automerge", accountId, ...storageKey]` |
| WAL entry | `["vault-local", 1, "wal", accountId, entryId, itemId]` |
| Index document | `["vault-local", 1, "index", accountId]` |

A record moved to another key, entry, store or account fails to decrypt. Records store raw bytes (`{ key, v: 1, iv: Uint8Array, ct: Uint8Array }`), not base64, because IndexedDB structured-clones typed arrays. Storage keys stay plaintext, since `loadRange`/`has` need them for range queries.

- **IndexedDB pitfall:** a transaction auto-commits as soon as it has no pending requests at the end of a task, so awaiting WebCrypto inside one throws `TransactionInactiveError`. Seal *before* opening the write transaction, and open (decrypt) *after* the read transaction completes. `loadRange` collects the raw records first and then decrypts them all with `Promise.all`.
- **A record that fails to decrypt throws. It's never treated as missing.** `load` must not return `undefined`, and `loadRange` must not skip the chunk. Either would make a present document look absent or silently drop part of its history, while `has()` still reports it.
  - **What happens instead:** the error reaches `AutomergeDocStore`, which quarantines the item with a new manual recovery kind, `localDecryption`. Its recovery is "replace from server".

### New databases, not in-place rewrite

Sealed data goes into **new databases** with new storage-name prefixes (`sealedAutomergeDatabase`, `sealedWalDatabase`):
- **Old builds aren't broken by the format change.** A tab still on a cached older build keeps reading and writing the plaintext database instead of misreading sealed records. An in-place rewrite would crash it, because records without `binary` look like missing chunks while `has()` says they exist, which the `hasDataInStorage` guard trips on. Deleting the plaintext database under it is still dangerous (see "Retiring the plaintext stores").
- **Crash safety is simple.** The plaintext database stays intact until the sealed copy is complete and marked.
- **The sealed database is created at version 1 with both stores** (`documents`, `meta`), so the wrapped DSK and the upgrade marker never share an object store with Automerge's keys.

Existing names never change (`src/app/vault/storageNames.spec.ts` pins them). These prefixes are additions.

### Opening local storage before the Repo

Today `AutomergeRepoManager.init` runs in the `SyncWorkerContext` constructor, and the Repo reads `storage-adapter-id` immediately. The upgrade can't run lazily inside the adapter, for four reasons:
- **Lookups would time out.** `AutomergeDocStore` would hit its handle timeouts while a long copy runs, and report documents that "exist in storage but could not be loaded".
- **`hasLocalData` would be wrong.** `initialize()` reads the index to decide it before `lifecycle.start`. If the plaintext index hadn't been merged yet, `DataVersionTracker.onStart` would record the device as new, at the current level, with its data still in plaintext.
- **The fallback needs a choice first.** The quota fallback has to pick the plaintext or sealed adapter before the Repo exists.
- **The lock would nest.** It would contend with the `migrateLocalData` hook for the same Web Lock.

So `SyncWorkerContext` is refactored so the Repo and the components that take it are created in `initialize()`, after a new `openLocalStorage()` step:

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

The keyring is loaded in `initGlobalPrerequisites` before the context is created, so the data keys are available here.

**Loading the DSK:**
- If `meta` holds a wrapped DSK, unwrap it.
- If `meta` has none and `documents` is empty, generate one and store it with `add` in its own transaction. On `ConstraintError` another tab won, so re-read. Generation happens under the lock, so two tabs can't each create one.
- If `meta` has none but `documents` isn't empty, raise `LocalKeyUnavailableError`. Generating a new key there would make every existing record unreadable.

### Upgrade (copy and seal)

`LocalEncryptionUpgrade` is opt-in through `SyncWorkerConfig.upgradeLocalEncryption`, like `upgradeSnapshotFormat`. Inside `openLocalStorage()`, per account, it:
1. **Detects plaintext data** with `indexedDB.databases()`, which lists the old Automerge or WAL database by name.
   - **Without that API** (Firefox before 126), it opens the plaintext database with the old adapter's own schema (`createObjectStore` in `onupgradeneeded`), so a database it creates is well formed for any old build that opens it later.
2. **Copies the Automerge records.** It reads in pages (a cursor over the raw records, batches of ~200), seals outside the transaction, then writes.
   - **What's copied:** `snapshot` and `incremental` chunks only. Their keys are content hashes (heads hash and `keyHash`), and the Repo merges every chunk it loads and compacts away superseded ones, so the copy is idempotent and resumes after a crash.
   - **`storage-adapter-id`** is copied only on the first import.
   - **`sync-state`** records are skipped. They're keyed per peer, not by content, so a copy could overwrite newer state, and the sync protocol rebuilds them.
3. **Copies WAL entries** with `data` sealed and the descriptor fields (`id`, `itemId`, `seq`, `createdAt`, `replaces`) unchanged, so `WalEntryQuery` still works. The plaintext WAL is copied, not dropped: a plaintext entry may be a change no snapshot covers yet.
4. **Merges the plaintext index** `indexDoc` into `indexDocSealed` (see "Index document").
5. **Writes `{ upgradedAt }`** to the sealed `meta` store.
6. **Retires the plaintext stores** (next section). If that can't happen yet, the upgrade still counts as done, and the next start re-imports anything new and tries again.

The upgrade runs on every start. It's a cheap check when nothing plaintext remains, and a merge if an old-build tab wrote to the plaintext stores since.

**Failure handling:**
- **Quota error mid-copy:** stop and keep the partial sealed data (it's idempotent). Run this session on the plaintext adapter, with a sync-status warning, and retry on the next start. This fallback exists only while plaintext compatibility ships (phase 1).
- **DSK can't be unwrapped:** raise `LocalKeyUnavailableError`. **The data is never reset automatically.**
  - **Causes:** a missing `kver` in this tab's keyring (for example a keyring loaded from an older cache), a corrupted record, tampering.
  - **First, retry with a fresh keyring:** wait for the key version (`waitForKey`, then a keyring refresh from the server when online, as `keyVersionMissing` does).
  - **If it's still unavailable:** worker initialization fails with this error, and the app shows that local data can't be opened. It offers "Try again" and a user-confirmed "Discard local data and download from the server". That option states how many changes haven't been pushed, from the WAL entry count, which is readable without the DSK.

### Retiring the plaintext stores

Deleting a database under a live old-build tab is unsafe. The old adapter closes on `versionchange`, then reconnects to a freshly created empty database. With the plaintext `indexDoc` gone, the old tab sees no items and saves an empty index. Its later loads find nothing in storage, and it carries on writing into the new empty stores. So before deleting the plaintext databases and the plaintext `indexDoc`:
1. **Ask other tabs to stop.** Flock passes a `beforeRetiringLegacyStores` hook that posts `{ type: 'started' }` on `MIGRATION_CHANNEL`. Every build since level 1's extraction locks itself on that message (`handleMigrationMessage`). Other new-build tabs lock too, once per device.
2. **Check nothing else is using the account.** Call `navigator.locks.query()` and look for other holders of the account's `leaderLock` and `indexLock`. Those names are pinned, so builds older than the takeover handler hold them too. Wait briefly (a few seconds) for them to release.
3. **Delete, or wait for the next start.** If no one else holds them, delete. Otherwise, skip deletion this time and retry on the next start.

### WAL

`SyncWriteAheadLog` seals `entry.data` in `append` and in compaction (`setItem`) and opens it in `readAll`/`iterate`, with the WAL associated data above. Like IndexedDB, localforage's `iterate` callback can't await, so it collects the entries first and decrypts them afterwards. Everything else about the WAL is unchanged, including pruning, `replaces` and in-flight tracking.

### Index document

`IndexStore` seals the whole `indexDoc` value with the DSK. localforage runs its own transactions, so sealing before `setItem` and opening after `getItem` is safe. The tombstone list matters most here: it is how the engine refuses to resurrect deleted items, so a lost or unreadable index is a correctness problem as well as a privacy one.

- **New key, not in-place.** The sealed value goes under a new key, `indexDocSealed`, in the same sync metadata database. An old-build tab that read a sealed value under `indexDoc` would not recognise its shape, treat the index as missing and save an empty one. That is the failure the `initialize()` ordering comment warns about.
- **Upgrade:** merge the plaintext `indexDoc` into the sealed one with `AutomergeIndexManager.mergeIndex`, the same union the backup import uses, so an old tab's later writes are merged in rather than lost. The plaintext key is removed only when the plaintext stores are retired.
- **Device-level gate:** `checkDeviceDataVersion` only asks whether an index exists. It checks for either key without decrypting, so the gate has no new dependency on the DSK.
- **DSK location:** the DSK lives in the sealed Automerge database's `meta` store, and `SyncWorkerContext` hands the loaded cipher to `IndexStore`. If the sync metadata database is dropped on its own, nothing is lost that a manifest sync can't rebuild. If the Automerge database is lost, the sealed index is unreadable too, but there are no local documents left for it to describe.

### Data levels

This is device level 3 (Part 1 is account level 2):
- **Phase 1 (compatibility):** `FLOCK_DATA_VERSION = 3`, `MIN_DEVICE_DATA_VERSION` stays 1. The main app passes `upgradeLocalEncryption: true`, and devices upgrade the next time they unlock.
  - **Device level:** `DataVersionTracker` records `min(FLOCK_DATA_VERSION, maxDeviceLevel())`, not the current level blindly as `recordDeviceVersion` does now. Flock's `maxDeviceLevel` returns 3 only when the sealed `meta` store has `upgradedAt` and the plaintext stores are retired, otherwise 2. This applies to both `onStart` and `onSyncedWithoutFailures`. The quota fallback therefore never records level 3.
  - **Account level:** level 3 has no server blockers, so the account level rises without a scan.
- **Phase 2 (extraction):** `MIN_DEVICE_DATA_VERSION = 3`. The main app drops the plaintext adapter and the upgrade. `src/migrate/migrate.worker.ts` passes `upgradeLocalEncryption`, and the device gate sends un-upgraded devices to `/migrate/`. `hasLegacyLocalData` also reports the plaintext databases.

### Cleanup paths

Every path that removes local data must include the sealed databases: `clearAccountLocalData` / `localDataCleanup.ts`, `ServiceLifecycleManager` (the Repo shuts down before its database is cleared, rule 5), `SyncWriteAheadLog.clear`, and `removeVaultFromDevice`.

### Performance

AES-GCM in WebCrypto runs at hundreds of MB/s, which is far above what hydration needs. The cost is one async call per chunk. Batching `loadRange` decryption with `Promise.all` keeps the overhead well under the IndexedDB read time. The upgrade temporarily needs about twice the Automerge database's disk space, which is why the quota fallback exists.

## Implementation plan

Part 1 ships before Part 2. Each step is a separate PR that passes `yarn test run`, `yarn typecheck` and `yarn lint`.

### Part 1: Argon2id

1. **Pre-flight (no merge).**
   - Query the minimum stored PBKDF2 `iterations` in `FlockAccounts` to set the PBKDF2 floor.
   - Record `hash-wasm` timings at 64 MiB/t=3/p=1 on an older phone and a desktop, for reference. The parameters themselves are decided.
2. **Derivation**
   - Add `deriveArgon2idKey` in a dedicated Worker, plus `kdf` on `InitialiseKeyParams`.
   - Add `DEFAULT_KDF` and the floor and ceiling checks for parameters read from the server or local metadata, for Argon2id and PBKDF2.
   - Specs: the reference implementation's argon2id vector (`hash-wasm` takes no associated data, so RFC 9106 §5.3 can't be reproduced), each parameter below the floor or above the ceiling is rejected, an unknown algorithm is rejected, Cypress parameters.
3. **Schemas and server**
   - Add `kdf` to the account record and to the create, change-password and security-params schemas, with shape validation only.
   - Add `randomDataKeys` and `keyring` to `createAccount`. The server sets `dataVersion` from the request.
   - `UnknownAccountParams` gains `kdf`. Add a spec that responses for real and unknown accounts have the same shape.
   - `listItemFormats` projects `kver`. Add the `legacyKeyDerivation` and `passwordDerivedDataKey` blocker rules.
   - Extend the driver specs and the Dynamo OCC tests.
4. **Random data keys**
   - `createAccount` and `CreateAccount.tsx` derive with Argon2id, generate v1 with `generateVaultKey()` and upload the keyring.
   - `initialiseVault` and `unlockWithBiometrics` stop seeding the keyring with the master key. `syncKeyringFromServer` stops seeding a missing keyring in the main app.
   - Specs: the keyring's v1 is never the master key, on every login path.
5. **`rewrapMasterKey` takes a `kdf`.** `needsKeyDerivationUpgrade` compares Argon2id parameters. The PBKDF2 re-wrap at login is removed.
6. **Legacy hook**
   - PBKDF2 moves behind a `deriveLegacyKey` hook, implemented in `src/app/vault/legacyKeyDerivation.ts` for phase 1 and passed by both apps.
   - The main app derives PBKDF2 only from cached parameters: a server response without `kdf` routes to `/migrate/`.
   - Specs: offline unlock with a PBKDF2 cache works, no session or re-wrap is attempted with a PBKDF2 key, the iteration floor is enforced.
7. **Account-level check after unlock**: after any password or biometric unlock, once online, call `getSecurityParams` and route to `/migrate/` below `MIN_ACCOUNT_DATA_VERSION`. Specs for both unlock paths.
8. **Migration app flow**
   - The state-driven steps in the table, with the new-password step (existing strength floor, differs from current, typed twice, consequences confirmed).
   - Password change before rotation, then re-encryption with progress once sync has settled, then deferral only after step 2. Oversized items are recreated from the main app's data recovery dialog.
   - Add `MigrateApp` and `migration` specs that resume from each state, on a different device as well as the same one.
9. **Data levels**
   - `FLOCK_DATA_VERSION = 2`.
   - Split Flock's minimum into `MIN_DEVICE_DATA_VERSION` (1) and `MIN_ACCOUNT_DATA_VERSION` (2), and update `isMigrationComplete`.
   - Add the blocker descriptions to `BLOCKER_DESCRIPTIONS`.
   - Raise `minProtocolVersion` in the same deploy as the server changes.
10. **Phase 2 (later)**: stop passing the PBKDF2 hook in the main app once the scan allows, and move it to `src/migrate/legacy/`. v1 stays in keyrings permanently.

### Part 2: local encryption

1. **Local cipher** (`packages/vault-client/src/sync/worker/localEncryption/LocalCipher.ts`)
   - Generate, store, unwrap and re-wrap the DSK, with the raw-bytes handling above.
   - `seal(context, bytes)` / `open(context, record)` with the associated data table.
   - Specs: round trip, each mismatched context field fails, wrong `kver` fails, re-wrap keeps the same DSK.
2. **Record codec in the adapter**
   - Refactor `VaultIndexedDBStorageAdapter` to take a record codec: the plaintext codec is today's behaviour, the sealed codec uses `LocalCipher`. Encoding happens outside transactions.
   - Add the two-store schema for sealed databases.
   - Specs (fake-indexeddb): sealed round trip, `loadRange` and `has`, no `TransactionInactiveError`, a corrupted record throws from both `load` and `loadRange`.
3. **Storage names**
   - Add the `sealedAutomergeDatabase` and `sealedWalDatabase` prefixes to `VaultStorageNames` and `createVaultStorageNames`.
   - Add Flock's values (for example `flock-automerge-sealed-`, `FlockVault_SyncWAL_sealed_`) and extend its pinning spec.
   - Update the cleanup paths and their specs.
4. **Sealed WAL and index**
   - WAL: seal `data` and decrypt after `iterate`. Update the WAL and `walThrashingPrevention` specs.
   - Index: `IndexStore` reads and writes `indexDocSealed` through the cipher. `checkDeviceDataVersion` checks for either key.
   - Specs: round trip, the existence check works without the DSK, a plaintext index is merged rather than overwritten.
5. **`SyncWorkerContext` refactor**: create the Repo and its dependants in `initialize()` after `openLocalStorage()`, with one lock acquisition around `migrateLocalData` and `openLocalStorage`. This is the riskiest step for regressions, because most components take the Repo in the constructor today. Land it on its own, with plaintext storage only, before any sealing.
6. **`LocalEncryptionUpgrade`**
   - Covers race-safe DSK creation, the password-derived-key guard, the chunk filter, detection, the quota fallback and plaintext-store retirement (`beforeRetiringLegacyStores`, the lock check), plus `LocalKeyUnavailableError` with its recovery UI and the `localDecryption` quarantine kind.
   - Specs:
     - full copy, a crash at each step then resume;
     - a plaintext database recreated after the upgrade, `storage-adapter-id` preserved, `sync-state` skipped;
     - unpushed WAL entries survive;
     - two tabs creating a DSK at once end with one key;
     - deletion skipped while another holder has the leader lock;
     - no automatic reset on unwrap failure.
7. **Re-wrap in rotation**: `reencryptAllItems` re-wraps the DSK under the new active key as its last step.
8. **Wiring and data level**
   - `openLocalStorage` picks the sealed or plaintext adapter.
   - `DataVersionTracker` takes `maxDeviceLevel`. `FLOCK_DATA_VERSION = 3`, and Flock passes the flag and the hook.
   - Integration spec (`sync.integration.spec.ts`): two workers sync while one is mid-upgrade.
9. **Acceptance test (Cypress)**
   - **Control first:** with upgrade disabled, create a person with a unique short name and check the name is found in the plaintext Automerge database. Automerge DEFLATE-compresses larger columns, so without the control a byte search could pass even though nothing is encrypted.
   - **Then:** with the upgrade enabled, lock, and assert that every record in the sealed databases has the sealed shape, that no plaintext databases or `indexDoc` key remain, and that the name's bytes appear in no IndexedDB database, localStorage key or Cache Storage entry.
10. **Docs**
    - Update "Local storage layout" in [sync-design.md](sync-design.md).
    - Add an AGENTS.md sync rule: "Never write user content to local storage unsealed; seal and open outside IndexedDB transactions; a record that fails to decrypt throws, it's never treated as missing."
11. **Phase 2 (later)**: extraction, as described in "Data levels".

## Related findings (separate fix)

- **Session tokens outlive closed tabs.** The session token (`authDatabase`) is cleared only by an explicit lock. If the tab is closed while unlocked, it stays in IndexedDB for up to 30 days (`SESSION_EXPIRY_MS`). Without the keys, a copied token can't read anything, but it can make authenticated writes:
  - **Soft-delete everything.** The server accepts payload-less tombstone snapshots (`toTombstoneSnapshot`), so a stolen token could soft-delete every item, and other devices would apply the deletions.
  - **Replace the keyring.** `accounts.updateKeyring` is a `protectedProcedure`, so it needs only the session. A stolen token can upload a garbage keyring with a higher `keyringVersion`.
    - **Effect:** every later login that reaches the server throws "Failed to decrypt keyring from server during login", even after the cached keyring verified the password. Every device is locked out.
    - **It also breaks Part 1's migration**, whose rotation step uploads the keyring.
  - **Fix options:**
    - Clear the token on `pagehide`, re-establishing the session at unlock as login already does.
    - Require proof of the keys for keyring uploads (the current auth token, as `changePassword` does).
    - Bind deletions to something only key holders can produce.

## Decisions

1. **Auto-lock default stays `never`** (`DEFAULT_AUTO_LOCK_SETTINGS`), for now. An unattended open tab stays unlocked and is outside this protection.
2. **Password strength floor stays at zxcvbn score 3** (`MIN_PASSWORD_STRENGTH`, about 10⁸ guesses), for new passwords and for the migration's new password.
3. **Argon2id parameters are 64 MiB / t=3 / p=1**, as in "Parameters".
