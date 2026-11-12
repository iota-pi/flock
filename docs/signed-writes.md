# Signed Writes

**Status:** not planned (2026-11-11).

## Decision

We won't build this. The design below is kept for reference in case the threat changes.

It only protects against a session token that leaks on its own, without the auth token and without a compromise of the running app (see [Threat](#threat)):
- **The token is kept only in memory,** so the realistic ways to steal it are XSS, a malicious extension or a compromised device. Each of those can sign through the unlocked app.
- **A leak of request bodies usually includes a login,** which carries the auth token. The auth token can already rotate in a signing key of its own, or replace the keyring.

What's left (a logged `Authorization` header, a crash report) is too narrow to justify the cost: about two weeks of work, a new account data level, and a protocol bump with a two-phase rollout.

The accepted risk is recorded under "Session tokens" in [local-encryption.md](local-encryption.md#session-tokens).

**Reconsider if:**
- session tokens are ever persisted again;
- the server needs to be treated as untrusted (see [Later](#later));
- a forged tombstone becomes unrecoverable in practice, for example if devices stop keeping local copies.

A session token can't read anything without the account's keys, but today it can make any item write. A token taken from a running, unlocked app can tombstone every item or overwrite snapshots and log rows with garbage until it expires (the "Still open" item in [local-encryption.md](local-encryption.md#session-tokens)). Forged tombstones are the serious case. Clients obey a manifest's `deleted` flag (`calculateSyncDeltas.ts`), and tombstones are terminal (sync rule 2), so one forged tombstone deletes the item on every device.

This design makes the server accept item writes only when they're signed with a key derived from the account's active data key.

## Threat

**The attacker has a valid session token, and possibly copies of earlier signed requests, but not the account's auth token** (`keyHash`, the hash of the master key). The session token lives only in memory, so this means it leaked without the app being compromised, for example:
- an `Authorization` header captured by a proxy, a log or a TLS-intercepting middlebox;
- a token in a crash or diagnostics report.

**Out of scope:**
- **Leaks that include the auth token.** `accounts.login` and re-establishing an expired session send it in the request body. Anyone holding it can already log in, call `updateKeyring` (upload a garbage keyring, or rotate in a signing key of their own) and `changePassword`, so signing adds nothing against them. A leak of whole request bodies is only in scope if it misses every login.
- **A compromised running app.** XSS or a malicious extension can sign through the app itself.
- **A malicious server.** That needs signatures that clients verify (see [Later](#later)).
- **Other mutations** (see [What stays open](#what-stays-open)).

This threat is narrow, which is why the item is rated Low–Medium. The design is worth building only because forged tombstones can't be undone.

## Goals

- `items.putSnapshots`, and `sync.pollLog` when it pushes, are rejected unless they're signed with the signing key of the account's active data key.
- A session token alone can't register or replace a signing key.
- A data key derived from a password never becomes a signing key.
- The keyring's stored format doesn't change, so older builds can still read it.
- Old builds, and accounts without a registered key, are sent to update or migrate rather than failing quietly.
- Signing never causes a 0ms re-poll loop, a session refresh, or the outbox's snapshot fallback. A device that can't push keeps pulling.
- The library's existing hooks are used: the keyring refresh and `onMigrationRequired`. No new host interface is needed.

## Replays

Signatures carry no nonce, because replaying a validly signed write does no lasting harm:

- **A log row** holds Automerge changes, and applying them twice is a no-op.
- **A tombstone** is terminal, so replaying it changes nothing. A replayed live snapshot can't un-delete an item either, because the driver keeps it deleted (`itemRecords.ts`).
- **An old snapshot** replaces the server's newer one, since uploads are intentionally last-write-wins. Hydration merges it, so nothing is lost on devices that already have the data. A fresh device could briefly hydrate older data, if the log rows written after that snapshot have expired (30-day TTL). The next manifest sync on any device with newer heads uploads again (S3 in [sync-design.md](sync-design.md)). This is the same recovery a stale concurrent upload already relies on.
- **A signature from a key that's been rotated out** stops working, because only the active kver's key is accepted (see [Enforcement](#server-enforcement)).

So a signature binds its content to the account, the item, the procedure and the data key version. Neither side keeps counters or other state.

## Signing keys

**Derived, not stored.** Each data key version `kver` has a signing key:

```
seed        = HKDF-SHA-256(ikm = raw data key kver, salt = empty, info = "vault-signing-v1", 32 bytes)
signing key = Ed25519 private key with that seed (imported as PKCS8: the fixed 16-byte header + seed)
public key  = the `x` field of the private key exported as JWK
```

- **The raw bytes are available.** Data keys are imported as extractable (`importVaultKey`, `generateVaultKey`, `deriveVaultKey`), so HKDF can read them.
- **Why derive:** the keyring's export format (`Record<kver, key> + activeVersion`) is unchanged. Older builds' `importKeyring` would throw on any entry that isn't an AES key, so a stored signing key would lock them out. Deriving also means every device already holds the signing key, with no new secret to store or sync.
- **No account in the derivation.** No two accounts share a data key, and the signed bytes already bind the account.
- **Native WebCrypto only.** Ed25519 is in Chrome 137+, Firefox 129+, Safari 17+ and Node 24, which Lambda runs. There's no fallback library.

**Password-derived data keys never sign.** On accounts created before random data keys (`randomDataKeys` false), data key v1 is the master key derived from the original password (`initialiseVault`). Anyone who knows that old password can derive v1, so a v1 signing key would be no stronger than the old password. The server therefore refuses to register a key for kver 1 on such an account, and those accounts have nothing to enforce until they rotate (see [Enforcement](#server-enforcement)). Level 2 already requires that rotation, so this only affects accounts that haven't migrated yet.

**Client API (`packages/vault-client/src/keys/`):**
- `KeyProvider` gains `sign(bytes): Promise<{ kver, sig }>`, which signs with the active version.
- `Keyring` gains `signingPublicKey(kver)`, used for registration.
- `Keyring` derives keys lazily and caches them per kver. `clear()`, `replace()` and `removeKey()` drop the cached keys.

## Signing format (`packages/vault-shared/src/signing.ts`)

Client and server import the same encoders, so the bytes they sign and verify can't drift apart. Each request carries one signature over the whole batch:

- **`snapshotBatchSigningBytes(input)`**
  - Starts with the tag `vault-sign-v1/putSnapshots`, then `account`.
  - Then, for each snapshot in order: `itemId`, `deleted`, `modified`, a SHA-256 hash of `snapshot` (`iv`, `cipher`, `kver`, `format`), and a SHA-256 hash of `heads` (likewise).
  - It covers exactly the fields `persistSnapshots` stores. `snapshotCursor` and `version` aren't stored, so they aren't signed. A spec checks that the stored record depends only on signed fields, so a field added later can't slip past unsigned.
- **`logPushSigningBytes(input)`**
  - Starts with the tag `vault-sign-v1/pollLog`, then `account`.
  - Then, for each message in order: `itemId` and a SHA-256 hash of `encryptedMessage`, with every field the schema keeps.
  - `after` is a read parameter and isn't signed.
- **Encoding:** explicit length-prefixed binary, never `JSON.stringify`.
  - Strings are their UTF-8 bytes exactly as sent. Base64 fields are not decoded.
  - Numbers are big-endian float64.
  - Booleans are one byte, and an absent optional field gets its own marker byte, distinct from `false` and from an empty string.
  - Zod's parsing and key order can't change the bytes.
- **Procedure tags** stop a signature for one procedure being used on the other. Binding `account` stops reuse across accounts. Binding `itemId` and hashing each payload stops a signature being reused for other content.
- **Schemas:** `PutSnapshotBatchSchema` and `PollLogSchema` gain an optional `signature: { kver, sig }`. A signature is about 88 base64 characters, well inside the request limits.
- **`verifySignature(publicKey, bytes, sig)`** uses `crypto.subtle`, which both browsers and Lambda's Node provide.
- **Specs:** golden vectors pin both encodings, and changing any signed field must break the signature.

## Registering the public key

**Storage:** the account record gains a single `signingKey: { kver, publicKey }` attribute. Only the active kver's key is ever accepted, so there's no reason to keep older ones. A single attribute can be written in the same `UpdateExpression` as the keyring, under the conditions the driver already uses, with no read-modify-write.

**The server refuses a registration that:**
- doesn't prove the master key (`currentAuthToken`), which keeps a session token from adding a key of its own;
- is for a kver other than the account's `keyringVersion` (missing counts as 1);
- is for kver 1 on an account without random data keys;
- would replace a registered key for the same kver with a different one. Registering the same key again succeeds and changes nothing.

### Where the key is registered

**Permanently, in the library.** These calls already prove the master key, and a new kver is registered in the same update as the keyring that holds it:

| Call | Writes `signingKey` for | Condition |
|---|---|---|
| `accounts.createAccount` | kver 1, which is random on new accounts | the existing `attribute_not_exists(account)` |
| `accounts.updateKeyring` (key rotation in `reencrypt.ts`, keyring seeding) | the new `keyringVersion` | the existing `expectedKeyringVersion` condition |
| `accounts.changePassword` | the active kver, if it isn't registered | the existing keyring version condition |

No device can sign with a kver created this way before the server knows it.

**For existing accounts, as a migration level.** Account level 4 means the active kver's signing key is registered.
- `FLOCK_DATA_VERSION` becomes 4, with the level's description added to `src/shared/flockDataVersion.ts`.
- `flockDataVersionPolicy.findBlockers` reports `missingSigningKey` when `signingKey.kver` isn't the account's `keyringVersion`.
  - An account still on a password-derived key reports `passwordDerivedDataKey` instead, which only rotation clears.
- New accounts start at 4.
- **The library** exposes `registerSigningKey(account)`. It calls a new `accounts.registerSigningKey({ currentAuthToken, kver, publicKey })`, conditioned on `keyringVersion = :kver`, when the server lacks the active kver's key. It does nothing when the active key is password-derived.
  - `accounts.getKeyring` returns the registered `signingKeyVersion`, so the client can tell what's missing without another request. Unlock already calls it through `syncKeyringFromServer`.

**Who calls it.** A `SyncBridge` option, `registerSigningKey: boolean`, decides. This follows the pattern of `upgradeLocalEncryption`. When it's on:
- the bridge calls `registerSigningKey` on unlock, after the keyring syncs from the server;
- it calls it again when the server answers `SIGNING_KEY_UNKNOWN`.

Flock's settings:

| Build | Phase 1 | Phase 2 |
|---|---|---|
| Migration app | on | on, permanently |
| Main app | on | off |

- **In the migration app,** registration runs right after login, before its worker pushes anything and before any blocker can offer **Continue** (`deferMigration`). It does this whatever the account's level is, so it also fixes an account that's at level 4 but missing a kver.
- **In the main app,** registration doesn't hold up unlock or the worker, because phase 1 still accepts a push to an account without a key. If it fails, for example offline, the next keyring sync retries it. `DataVersionTracker` then raises the account to 4 as part of its normal check, so most active accounts reach the new level without visiting `/migrate/`.

## Client: signing and errors (`packages/vault-client/src/worker/`)

- **Signing happens in `SyncApiClient.putSnapshots` and `SyncApiClient.pollLog`**, before `executeWithAuth`. The signature doesn't depend on the token, so a token-refresh retry reuses it.
- **Every write path goes through those two methods:** `snapshotUpload.ts`, `ChangeOutbox`, `ItemRecoveryService` tombstones, `FirstStart`, the account settings document, and the migration app's worker (`src/migrate/migrate.worker.ts`).
- **A `pollLog` with an empty push** is a read and isn't signed.

**Error codes.** Every rejection uses `PRECONDITION_FAILED` (412) with its own message, chosen to avoid existing client behaviour:
- **Not `FORBIDDEN`/403:** `errorClassifier.ts` treats it as an auth error, so `executeWithAuth` would refresh the session and then report it expired.
- **Not 400/413/422:** `ChangeOutbox` treats those as a refused request and falls back to sending each item as a snapshot, which would multiply rejected uploads.

**Handling in the client** (`classifySyncError` recognises each message):

| Message | Meaning | Client response |
|---|---|---|
| `SIGNING_KEY_STALE` (carries the active kver) | signed with a kver older than the account's active one | Pause pushes and raise the worker's existing keyring-update event with that kver. `SyncBridge.handleKeyringUpdate` fetches the keyring from the server when the kver is missing, and sends it to the worker (`updateVaultKey`), which switches the active version. Resume pushing once the active version matches. If the refresh fails, the kver stays pending in `pendingMissingKeyVersions` for the next keyring update (such as on reconnect), so there's no tight retry loop. |
| `SIGNING_KEY_UNKNOWN` | the active kver has no registered key | Pause pushes. If the bridge's `registerSigningKey` option is on, register and resume. Otherwise the worker emits `migrationRequired { reason: 'account' }`, and Flock's existing `onMigrationRequired` locks the vault and sends the user to `/migrate/`, deferral or not. |
| `SIGNATURE_REJECTED` | the signature doesn't verify, or a v6 build sent an unsigned push | A bug, which a retry won't fix. Log it, report a sync failure, back off normally. |

- **Pausing pushes never pauses pulls.** While pushes are paused, the poller still sends `pollLog` with an empty push, so the device keeps receiving changes. Pending marks keep the unpushed changes for when pushing resumes.
- **Rule 4 holds:** `SyncPoller.executePoll` returns `'failure'` whenever a push was rejected.

## Server: enforcement

`protectedProcedure` has already loaded `ctx.accountData`, so checking a signature needs no extra read. `persistSnapshots` and `pollLog` verify before writing anything. A failure rejects the whole call, including a `pollLog`'s read, never part of it.

**Enforced accounts:**
- **Phase 1:** an account is enforced once it has a `signingKey`.
- **Phase 2:** every account is enforced, except one whose active data key is password-derived (`randomDataKeys` false and `keyringVersion` ≤ 1).
- **Accounts that aren't enforced** accept pushes signed or not. For a password-derived account this is an accepted risk, because its data key is already only as strong as an old password. Such an account only runs in the migration app (it's below level 2) or under a deferral, and it becomes enforced the moment it rotates.

For an enforced account, where `active` is `keyringVersion` (missing counts as 1):

| Push | Response |
|---|---|
| Signed with `active`, which matches `signingKey.kver`, and the signature verifies | write |
| Signed with a kver below `active` | `SIGNING_KEY_STALE` |
| Signed with `active`, but `signingKey` is for an older kver or missing | `SIGNING_KEY_UNKNOWN` |
| Signature that doesn't verify, or a kver above `active` | `SIGNATURE_REJECTED` |
| Unsigned, protocol < 6 | `CLIENT_OUTDATED` |
| Unsigned, protocol ≥ 6 | `SIGNATURE_REJECTED` |

**Why only the active kver is accepted.** Older keys stay in every device's keyring, so accepting them would let a leaked old data key sign forever. On accounts without random data keys, that includes kver 1, which anyone who knows the original password can derive. Accepting only the active key makes rotation retire the old signing key too. The cost is the brief `SIGNING_KEY_STALE` round trip on devices that haven't loaded the rotation yet. Rotation is rare, mostly during migration.

**The protocol header is not a security check.** A thief can send any version. Claiming v5 only gets them `CLIENT_OUTDATED`, so the write is still refused. The version only lets an old build learn it should update (via `clientOutdated.ts`) rather than retry forever.

Server-side migrations (`src/vault/migrations/`) write through the driver and aren't affected.

## Rollout

### Phase 1: one release

- **Versions:**
  - `VAULT_PROTOCOL_VERSION` becomes 6. `MIN_PROTOCOL_VERSION` stays at 5. Add the v6 line to its version history comment in `src/vault/api/index.ts`.
  - `FLOCK_DATA_VERSION` becomes 4. `MIN_ACCOUNT_DATA_VERSION` stays at 2.
- **New builds:**
  - Both apps register on unlock or login.
  - Every push is signed.
  - `DataVersionTracker` raises active accounts to level 4.
- **Deploy skew.** The site and the API don't switch over at the same instant.
  - **A new client against the old server:** the old server ignores `signature` (Zod strips unknown keys) and `signingKey` in account calls. `registerSigningKey` answers `NOT_FOUND`. Registration failures are logged and never block unlock or sync, and the next unlock or `SIGNING_KEY_UNKNOWN` retries.
  - **An old client against the new server:** the old client gets phase-1 behaviour.
- **Old builds:** once an account is enforced, its old builds get `CLIENT_OUTDATED` on their next push and update. Their unsent changes survive, because pending marks are persisted and changes are read from the doc. The updated build pushes them signed.
- **An old migration app rotating a key:** an old build's migration app could rotate a key (`reencrypt.ts`) without registering it. The account's next signed push gets `SIGNING_KEY_UNKNOWN`, and registration fixes it.
- **Reporting:** the report in `src/vault/migrations/index.ts` already counts accounts by level and blocker. Use the level-4 count and `missingSigningKey` to decide when phase 2 can ship.

### Phase 2: once the active accounts are at level 4

- **Versions:** raise `MIN_PROTOCOL_VERSION` to 6 and `MIN_ACCOUNT_DATA_VERSION` to 4.
- **Server:** enforce every account except password-derived ones.
- **Main app:** turn `registerSigningKey` off. `useAccountLevelCheck` sends every account below level 4 to `/migrate/` before the main app's worker starts. An account that's at level 4 but missing a key gets `SIGNING_KEY_UNKNOWN`, then `migrationRequired`, and goes to `/migrate/` too. That covers the phase-1 rotation case, and a **Continue** that deferred a failed registration.
- **Old builds can no longer rotate.** `MIN_PROTOCOL_VERSION` 6 rejects their `updateKeyring`, so every kver created from now on is registered when it's created.

## Docs and rules

- **[local-encryption.md](local-encryption.md#session-tokens):** replace "Still open" with a summary of this design, its threat boundary (the auth token) and its remaining gaps.
- **[sync-design.md](sync-design.md):**
  - every item push is signed with the active kver and verified before anything is written;
  - a device that can't push keeps pulling.
- **AGENTS.md:** add sync rule 11: "Every item write is signed with the active data key's signing key, and the server verifies it before writing. Never accept a signature from an older kver or a password-derived key."
- **[vault-extraction.md](vault-extraction.md):** in phase 2, add level 4 and its retirement to "Backwards compatibility".

## Testing

- **Shared:** golden vectors for both encodings. Changing any signed field must break the signature. A tag or account mismatch must fail. An absent field and an empty or false one must encode differently.
- **Keyring:** derivation is deterministic in every realm, different kvers give different keys, and the cache clears with the keyring.
- **Server:**
  - every row of the enforcement table, and which accounts are enforced in each phase;
  - a signature checked against the wrong account or the other procedure;
  - registration needs `currentAuthToken` and `kver = keyringVersion`, is idempotent, and rejects a conflicting key and kver 1 on a password-derived account;
  - `updateKeyring` stores the keyring and the key in the same update, and a concurrent registration for the old kver loses to it;
  - the `missingSigningKey` blocker holds an account below level 4 until its key is registered.
- **Sync integration (`syncLogHarness`):** the harness verifies signatures.
  - A rotation on one device makes the other get `SIGNING_KEY_STALE`, refresh its keyring through `handleKeyringUpdate` and retry.
  - A failed refresh leaves pushes paused without a tight loop.
  - `SIGNING_KEY_UNKNOWN` registers when the option is on, and emits `migrationRequired` when it's off.
  - While pushes are paused, pulls continue.
  - A rejection never causes a 0ms re-poll, a session refresh or a snapshot fallback.
- **Deploy skew:** a new client against an old server's schemas still syncs, and its registration failure doesn't block unlock.
- **Migration app:**
  - An account seeded at level 3 (`scripts/seedLegacyAccount.ts`) registers on login and reaches level 4, before the worker's first push.
  - A password-derived account registers nothing until it rotates, then registers the new kver.
- **Cypress:** sync smoke tests pass, and an unsigned `putSnapshots` with a valid token is rejected.

## What stays open

A session token can still call:
- **`flockAccounts`:** push subscriptions, reminder settings and snoozes. This is a nuisance, with no data loss.
- **`migration.clearLegacySettings`:** this wipes the account's legacy settings, which matters for accounts still waiting to migrate. Consider requiring `currentAuthToken` here, or retire it with its level.
- **`raiseDataVersion`:** the server only raises it when its own checks pass.
- **Every read.** Everything read is ciphertext.

Accounts that aren't enforced (see [Enforcement](#server-enforcement)) also stay as exposed as today. So does any account whose auth token leaks (see [Threat](#threat)).

## Later

- **Storing signatures with items and log rows.** Clients could then verify what they fetch, which protects against a malicious or compromised server as well as a stolen token. Fetched rows would also need the signer's public key, so clients would need a trusted copy of `signingKey`. The account settings document could pin it.

## Estimate

About 2 weeks:
- a few days for keys, the signing format and registration;
- a few days for client signing, the error handling and the server checks;
- the rest for the level-4 migration, testing and rollout.

Phase 2 is a small follow-up release.
