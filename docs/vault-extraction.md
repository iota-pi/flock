# Vault Extraction Plan

Goal: extract the vault (client-side encrypted, local-first, near real-time sync) into a reusable module that other projects can use. This document records where the code is coupled to Flock, the target shape and the order of work.

Read [sync-design.md](sync-design.md) first. Its rules become the library's invariants.

## Summary

Extraction is feasible. Most of the engine is already generic. The WAL, poller, leader election, manifest reconciliation, recovery store, encrypted cross-tab adapter and CRDT list reconciler know nothing about Flock. The coupling falls into three groups:

1. Flock logic inside the engine.
2. App wiring: store and Sentry calls, Vite-only imports, hard-coded names and singletons.
3. Protocol choices that are cheap to change while Flock is the only consumer and expensive after publishing.

## Coupling inventory

### Flock logic inside the engine

| Where | What it knows | Replacement |
|---|---|---|
| `normalizeItemSnapshot` (`AutomergeDocStore`) | Flock zod schemas, group-only fields, the "Corrupt Item" error item | App-supplied `DocCodec`. The engine only needs `id` and `deleted`. |
| `ItemOperations.recreateOversizedItem` | Rewrites `group.members`, resets `created` | `remapReferences` and `prepareRecreatedDoc` hooks |
| `ItemOperations.forceOverwriteRecoveryItem` | Special-cases `prayedFor` | Removed. The JSON round-trip already copies it. |
| `utils/metadataSync.ts` | Field-by-field merge of Flock settings | `MetadataSyncAdapter` (stage 1), then deleted (stage 2) |
| `snapshotBuilder` / `utils/snapshot.ts` | Sends `person`/`group`/`topic` to the server | `DocCodec.snapshotKind` (stage 1), then dropped (stage 2, done) |
| `syncProtocol`, `SyncEventHub`, `SyncBridge` | `Item`, `AccountMetadata`, `BackupSyncState` types | Generic `VaultDoc` / `VaultMetadata` types and a library-owned sync state export schema |
| `generateItemId` in `src/utils` | Rule 2 depends on it | Library-owned ID generation |

### App wiring

- The main-thread client writes into `useAppStore` and calls Sentry directly. → `SyncStateSink` and `SyncTelemetry` interfaces supplied by the app.
- `src/api/vault/index.ts` dynamically imports `useAppStore` and `SyncBridge`, and holds reminder and push-notification code. → host hooks; lock and remove-from-device orchestration moves to the app.
- The worker is created with a Vite `new URL(...)` and loads Automerge's wasm via `?url`. → the app owns the worker entry file.
- About 20 hard-coded `flock-`/`Flock` names for IndexedDB, BroadcastChannels, Web Locks, localStorage and WebAuthn. → `VaultStorageNames` configuration. **Flock must keep its exact existing names**, or users lose local docs, the WAL and the cached keyring.
- The client is typed against the whole server router. → a library-owned `VaultRouter` type.
- Server: the account schema, driver and accounts router mix generic auth and keyring with reminders and push subscriptions; table names default to `Flock*`.

### Protocol choices (stage 2)

1. **Account settings are stored on the server in plaintext** (`accounts.updateMetadata`). Make settings an encrypted Automerge doc with a fixed per-account ID created with the account. Keep its top level flat, because concurrent creation of the same nested map loses one side.
2. **Drop the plaintext item `type`** sent with snapshots. The client never reads it back.
3. **Bind ciphertexts to their document.** AES-GCM is used without associated data, so a malicious server could serve one item's snapshot as another's. Add the doc ID as associated data, with a format version on `CryptoResult`.
4. **Opaque pagination tokens** instead of DynamoDB keys (`{account, syncId, cursor}`) on the wire, so non-Dynamo drivers are possible.
5. **Legacy code** to delete, or to move behind library hooks and then into the migration app (see "Backwards compatibility"): the `cipher` item format (`decryptLegacyCipher`), the old salt encoding, lazy migration from per-store IndexedDB databases, the timestamp fallback in `ManifestDeltaCalculator` and the `compactItem` alias.

### Scope limits

- One user, many devices. Sharing docs between accounts needs a different key model.
- Cross-device latency is bounded by the poll timer (30s, backing off to 5 min). A payload-free "poke" over SSE, WebSocket or web push could trigger `flush()` without the server seeing data.

## Target shape

| Package | Contents |
|---|---|
| `vault-shared` | Wire schemas, size limits, ID generation and isomorphic helpers (`src/shared/vault/` today) |
| `vault-client` | Crypto, keyring and biometrics; worker engine (`/worker` subpath); main-thread client |
| `vault-server` | Services, driver interface, Dynamo driver, tRPC routers and auth middleware |

Flock keeps its item schemas, the codec and hooks, reminders and the notifier, and the store adapter. Legacy migrations go to the migration app.

## Backwards compatibility

Every format change ships with full backwards compatibility, so anyone who opens the app is migrated as they use it. Later, the compatibility code is extracted into a separate migration app for accounts and devices that stayed away for too long. The main app then drops it, so legacy code doesn't stay in the codebase indefinitely.

### Shape

- **Hooks in the library, implementations in Flock.** The library reads and writes only current formats. Each legacy format gets a generic hook (`LegacySettingsSource` is the model). Flock's implementations live in `src/app/vault/legacy/`, which is what gets extracted. Only Flock's wiring (`syncDomain.ts`, `setup.ts`, `vault.worker.ts`) may import from it, and a lint rule enforces this.
- **Migration levels.** A migration level is a numbered set of migrations. Level 1 is stage 2. Two markers record how far migration has got:
  - The **account level** (`dataVersion` on the account record) describes the server's data. Clients ask for it to be raised once their migrations finish. The server only raises it after checking the account's rows itself (one query on the account's partition) and never lowers it. `getSecurityParams` returns it, because the app has to decide where to send the user before deriving keys.
  - The **device level** describes local data. It is kept per account in a new localStorage key (a new name, so it doesn't break the rule that existing names never change). The app writes it once local migrations have finished and the WAL has drained once. A device with no vault data starts at the current level.
- **Old builds.** A device that has been away loads its cached build first, and that build talks to the server until the service worker updates it (`registerType: 'autoUpdate'`). The client sends its protocol version in a header; builds from before the header count as version 0. The server rejects writes below `minProtocolVersion` with a dedicated error, and the client responds by updating the service worker and reloading. Server shims that exist only for old builds (dropping legacy fields, accepting writes and discarding them) are removed when the minimum is raised. That can happen weeks after a release, independently of the migration app.
- **Destructive cleanups wait.** A server migration that removes data a legacy path still reads (`removeLegacyAccountMetadata`, removing `cipher`) runs only when its level is retired, because until then the migration app needs that data.

### Extraction (later)

1. Move `src/app/vault/legacy/` and Flock's legacy server procedures into the migration app: a separate Vite entry built against the current library plus the legacy hooks, with a login screen and a progress view. It must be served from the **same origin** (for example `/migrate/`), because local data in IndexedDB and localStorage is per origin. The service worker must not serve the main app's shell for that path. The legacy server procedures go into a `migration` router that only the migration app calls.
2. In the main app, route to the migration app when the stored account's device level is below the minimum (checked at startup, before the worker opens) or when `getSecurityParams` reports an account level below the minimum.
3. The migration app logs in, runs that level's migrations, raises both levels and returns to the main app.
4. Retire a level once the account-level scan shows no accounts below it, or the rest are accepted as abandoned. Recording `lastSeenAt` on the account (set when a session is created) makes that call possible. Then run the level's destructive cleanups and delete its migrations from the migration app.

The migration app is rebuilt against the current library, so the library keeps the legacy hooks after extraction and their signatures have to stay stable. Each new level follows the same path: compatibility in the main app first, then extraction.

## Stages

### Stage 1: decouple in place

No workspace packages yet. The library code stays in the tree, and Flock supplies the implementations.

Library zones:

- `src/shared/vault/`: wire schemas, IDs, size limits and isomorphic helpers
- `src/sync/`: worker engine and main-thread client
- `src/api/vault/`, `src/api/runtime.ts`, `src/api/trackedFetch.ts`, `src/api/vaultTrpcClient.ts`: client crypto, keyring and API calls
- `src/vault/services/`, `src/vault/drivers/`, `src/vault/trpc/trpc.ts`, `src/vault/trpc/vaultRouter.ts`, `src/vault/trpc/routers/{accounts,items,sync}.ts`, `src/vault/util.ts`: server

Everything else is Flock. Flock's client wiring lives in `src/app/vault/`, and its server wiring in `src/vault/flockDriver.ts`, `src/vault/trpc/root.ts` and `src/vault/trpc/routers/flockAccounts.ts`. `VAULT_LIBRARY_PATHS` in `eslint.config.js` lists the library zones.

Status: **done.** The lint rule reports no violations, specs included.

- [x] Generic schemas, limits and `generateItemId` moved into `src/shared/vault/`. `ItemEnvelopeMetadataSchema.type` and the server's stored `metadata.type` are now plain strings.
- [x] `DocCodec`, `SyncDomainHooks` and `MetadataSyncAdapter` (`src/sync/worker/domain.ts`). Flock's implementations are in `src/app/vault/syncDomain.ts` and `metadataSync.ts`. Without a domain, the engine passes documents through and keeps metadata local.
- [x] `VaultDoc` / `VaultMetadata` types through the engine and events; `SyncApi`, `SyncBridgeService` and `SyncStateSink` are generic over the app's types.
- [x] `VaultStorageNames` (`src/sync/shared/storageNames.ts`); `FLOCK_STORAGE_NAMES` reproduces every existing name. Legacy per-store databases are opt-in via `legacySyncDatabases`.
- [x] `exposeSyncWorker(config)` started from Flock's `src/app/vault/vault.worker.ts`.
- [x] `createSyncBridge({ createWorker, sink, telemetry, getAccountId, lockVault })`; Flock's instance (Zustand sink, Sentry telemetry) is `src/app/vault/syncBridge.ts`.
- [x] `configureVaultHost` hooks (`getAccountId`, `onSessionLost`); the vault exposes `lockVaultKeys` and `clearVaultDeviceData`. `loadAccount`, `lockVault` and `removeVaultFromDevice` live in `src/app/vault/session.ts`, and reminder calls in `src/api/notificationClient.ts`.
- [x] `src/api/vaultTrpcClient.ts` typed against `VaultRouter`, with `configureVaultEndpoint`.
- [x] Server: Flock's account fields and procedures split out; `DynamoDriver` takes table names (or the env vars) and `accountDefaults`; `updateAccountData<TExtra>` accepts app fields; `accounts.*` paths are unchanged via `mergeRouters`.
- [x] Lint rule (`import-x/no-restricted-paths`).

Differences from the plan:

- The shared directory is `src/shared/vault/` rather than `src/shared/protocol/`, because it also holds isomorphic helpers (`concurrency`, `syncErrors`).
- The main-thread client takes a `SyncStateSink` object rather than exposing `on(event)`. Some event handling reads state back (quota recovery checks the current status and warning), and a sink keeps that policy in the library.
- `remapReferences` returns the changes to apply rather than editing a draft, so recreation still merges `members` through the CRDT list reconciler exactly as before.
- Storage names live on `globalThis` (under a `Symbol.for` key), because they belong to the realm and must survive tests that reset modules.
- The worker still imports the module-level keyring in `src/api/vault`. Both sides are library code, so a `KeyProvider` interface is deferred to stage 3.
- `SyncWorkerHealthMonitor` now reports through the bridge's status callbacks, so its warnings also get Sentry breadcrumbs.

Follow-ups noticed along the way:

- `getAuthToken` in `src/vault/api/util.ts` is only used by its test.
- `dynamo.test.ts › getGlobalSyncMessagesAfterCursor reports the highest cursor scanned` fails on `master` too.

### Stage 2: protocol changes

Each item under "Protocol choices" above, with a Flock data migration.

- [x] 2.1: Account settings live in an encrypted settings document (`AccountSettings`) with the fixed ID `settings-${account}` (`settingsDocId`). It syncs like any other document and stays in the item index, so manifest sync, key rotation and backups include it, but the worker keeps it out of the app's item stream and emits its keys as `metadataUpdated` instead. The app lists the synced keys in `SyncDomain.syncedMetadataKeys`; other keys stay on the device. The document is created on the first write, never deleted or recreated, and edits nested values in place so concurrent edits merge. `MetadataSyncAdapter`, the engine's `updatedAt` stamping and the library's `accounts.getMetadata`/`updateMetadata` and account `metadata` field are gone.
  - Migration has to run on the client, because only clients can encrypt. After each manifest sync, `AccountSettings.migrateLegacySettings` asks the app's `LegacySettingsSource` for legacy settings, writes the keys the document lacks, clears the source and removes the synced keys from local metadata. Running it again is harmless. Flock's source (`src/app/vault/legacySettings.ts`) merges the server's plaintext copy with the device's copy by `updatedAt`, as before, and clears the server copy.
  - Flock's router keeps `accounts.getMetadata` (read-only), `accounts.updateMetadata` (accepts and discards writes from cached clients, whose settings stop syncing until they update) and adds `accounts.clearMetadata`. Deploy the server before the client.
  - Compatibility: `legacySettings.ts` moves to `src/app/vault/legacy/`. The account level counts this as done once the account record has no `metadata`; the device level, once the synced keys are gone from local metadata. `accounts.updateMetadata` only serves old builds and goes when `minProtocolVersion` is raised. At extraction, `accounts.getMetadata`, `accounts.clearMetadata` and `LegacySettingsSource`'s implementation move to the migration app. `removeLegacyAccountMetadata` and the removal of `FlockAccountFieldsSchema.metadata` wait until level 1 is retired.
- [x] 2.2: Snapshots no longer carry a plaintext `type`, and `DocCodec.snapshotKind` is gone. The server stops requiring `metadata.type`, and each new snapshot write replaces the whole `metadata` map, so it drops the field. Run the `removeItemTypeMetadata` migration to strip it from older rows. Deploy the server before the client: the old server rejects snapshots without `type`, while the new one ignores the `type` that cached old clients still send.
  - Compatibility: no client migration. Leftover `type` fields are harmless, so `removeItemTypeMetadata` can run at any time. Ignoring `type` only serves old builds and goes when `minProtocolVersion` is raised.
- [x] 2.4: Pagination tokens are opaque strings (`PageToken`): `pullCursors[].pageToken` and `globalPageToken` in `pollSync` requests, `nextPageToken` and `globalNextPageToken` in responses. Drivers issue and check them (`getSyncMessages`, `getGlobalSyncMessagesAfterCursor`, `validatePageToken`, `InvalidPageTokenError`); the Dynamo driver encodes its `LastEvaluatedKey` as base64url JSON and keeps the old account and item checks. The service and router no longer know the key shape.
  - No migration or deploy order. The fields were renamed, so an old client and a new server (or the reverse) each drop the other's field, and the client pages by cursor instead, which pulls already support.
- [x] 2.3: Snapshots and sync messages are encrypted with the item ID as AES-GCM associated data and carry `format: 2` (`DOC_BOUND_FORMAT`), so a ciphertext only decrypts as the item it was written for. Only the doc ID is bound: an account binding adds nothing while keys are per account, and swapping a snapshot for a message of the same item already fails to parse. The keyring, cross-tab messages and backup files stay unbound, because the server cannot swap them for anything useful.
  - Unbound ciphertexts still decrypt, so the binding protects nothing against a malicious server yet: it can keep serving unbound ciphertexts it has stored. After each manifest sync without failures, `SnapshotFormatUpgrade` rewrites every snapshot once per device through `ItemReencryptor` (no key rotation). Sync messages expire after 90 days.
  - Deploy the server before the client. The server schemas and the Dynamo driver keep `format`; an old server drops it, which leaves bound ciphertexts undecryptable. Cached old clients cannot read bound ciphertexts until they update.
  - Compatibility: the account level counts this as done once none of the account's rows that aren't deleted has an unbound snapshot. Deleted rows don't count, because hydration never decrypts them; `countUnboundSnapshots` should skip them too, or it will never reach zero. The library gets an `acceptUnboundCiphertexts` option, which Flock sets now. `SnapshotFormatUpgrade`'s once-per-device trigger moves to `src/app/vault/legacy/`; the rewrite itself (`ItemReencryptor.reencryptAllItems`) stays in the library. At extraction, the main app stops accepting unbound ciphertexts and the server rejects unbound writes, while the migration app keeps reading them so it can rewrite them.

- [ ] 2.5: Legacy code and the infrastructure for the compatibility model. Ship 2.5b before anything is extracted: the markers only count what builds released after it record.
  - [x] 2.5a: Dead code, deleted outright because nothing depends on it.
    - The `compactItem` alias (`ItemOperations`, `sync.worker.ts`, `syncProtocol.ts`, `SyncBridge`, and its mention in `sync-design.md`). The bridge and the worker ship in the same bundle, so there's no version skew.
    - The timestamp fallback in `ManifestDeltaCalculator`. `ManifestSyncManager` has always passed `localVersionsMap` since the switch to versions. Make it required, and delete the fallback branches, `clockSkew` and `SKEW_BUFFER_MS`. `localLastModifiedMap` stays, because quarantine and tombstone tracking use it.
    - The "legacy single key" branch in `initWorkerVault`. Every caller passes `exportKeyringData()`, which always has an `activeVersion`.
    - `compactedAt` in the item metadata schemas. Nothing reads or writes it.
  - [ ] 2.5b: Infrastructure.
    - `src/app/vault/legacy/` and the lint rule that keeps it isolated. Move `legacySettings.ts` into it.
    - A protocol version header from the tRPC client, `minProtocolVersion` on the server (0 for now), and an error the client handles by updating the service worker and reloading.
    - The account `dataVersion`, a procedure that raises it after checking the account's rows, `dataVersion` in `getSecurityParams`, and `lastSeenAt`.
    - A device-level key in `VaultStorageNames` (Flock: a new key), written by the worker.
    - A read-only `countAccountsByDataVersion` migration that also reports why each account is held back. It replaces `countUnboundSnapshots`.
    - Level 1 checks for the account: no `metadata` on the record, `saltVersion` 1, and among rows that aren't deleted, no unbound snapshot and no `cipher` row without a `snapshot`. For the device: none of the legacy layouts in 2.5c remain, no synced settings keys remain in local metadata, and the WAL has drained.
  - [ ] 2.5c: Local storage layout.
    - Library: a `migrateLocalData(accountId)` hook in the worker config, run in `SyncWorkerContext.initialize()` before any store is read. Remove the following, so stores only read the current shape:
      - the legacy options and `migrateLegacyData` in `ScopedMetadataStore`
      - `LEGACY_KEYS`, `getLegacySyncDatabaseNames`, `hasLegacyDatabase` and `probeDatabaseExists`
      - `VaultStorageNames.legacySyncDatabases`
      - `clearLegacySyncDatabases` in `localDataCleanup`
      - `CursorStore.shouldUpgradeInPlace`, and the numeric form in `LastModifiedStore`
    - Flock (`legacy/localData.ts`): a one-shot import that brings over:
      - the four per-store databases (until 2026-09-14)
      - legacy keys in the consolidated store
      - the old `manual-recovery-metadata` store and the deduplication in `manualRecoveryStore.runMigration`
      - cursor arrays and numeric `lastModified` entries
      
      It copies a value only when the new key is missing, and only then removes the old one, so tabs running it at the same time are safe. Its cleanup runs from `removeVaultFromDevice`.
    - Dropping this without a migration path would lose the index doc on devices that haven't run the app since the consolidation. Their unsynced items would stay in Automerge storage but drop out of the index, so nothing would sync them.
  - [ ] 2.5d: Old salt encoding. Re-deriving the key needs the password, so the server can't migrate this.
    - Library: key derivation only knows `saltVersion: 1`. Flock supplies `decodeLegacySalt` (UTF-8 bytes of the base64 string) through `configureVaultHost` from `legacy/`.
    - Upgrade at login: after an online login with a legacy salt (or iterations below the default), call `changePassword(account, password, password)`. Data keys are unaffected, because key `'1'` (the original derived key) is stored in the keyring the change re-wraps.
    - Like any password change, this signs out other sessions and clears biometric unlock on this device. It has to: a device still holding the old master key could upload a keyring wrapped with it (key rotation goes through `storeVault`), which the new salt can't open. Tell the user why they're signed out elsewhere.
    - Server: drop the `salt ?? account` fallback in `getSecurityParams` once the scan shows no account without a `salt`.
  - [ ] 2.5e: The `cipher` item format.
    - Library: a `decodeLegacyItem` hook on `SyncDomain`, which `ManifestHydrator` calls when an item has no usable snapshot. It replaces `hydrateLegacyCipher`/`decryptLegacyCipher`, and Flock's implementation in `legacy/` decrypts `cipher`.
    - Items decoded this way are marked dirty, so they upload a bound snapshot straight away. Today they are stored with `markDirty: false` and reach the server only through the one-off rewrite.
    - Server: `DynamoDriver.set` removes `cipher` when it writes a snapshot. At present it only sets fields, so rows keep both.
    - At extraction: `LegacyItemEnvelopeSchema`, the `cipher` fields and the legacy branch of `validateItem` leave the library. `metadata.iv` (written as `''` for snapshots) becomes optional on the client now and stops being written once `minProtocolVersion` excludes builds that require it. At retirement: a `removeLegacyCipher` migration.

### Stage 3: workspaces

Move the library zones into `packages/*`, rewrite `src/...` alias imports and move the tests with them.

### Stage 4: publish

Only once a second app uses it.
