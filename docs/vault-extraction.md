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
3. **Bind ciphertexts to their context.** AES-GCM is used without associated data, so a malicious server could serve one item's snapshot as another's. Add `account|docId|kind` as associated data, with a format version on `CryptoResult`.
4. **Opaque pagination tokens** instead of DynamoDB keys (`{account, syncId, cursor}`) on the wire, so non-Dynamo drivers are possible.
5. **Legacy code** to delete or move into Flock-only plugins: the `cipher` item format (`decryptLegacyCipher`), the old salt encoding, lazy migration from per-store IndexedDB databases, the timestamp fallback in `ManifestDeltaCalculator` and the `compactItem` alias. Scan production `FlockItems` for rows with `cipher` and no `snapshot` before removing the first.

### Scope limits

- One user, many devices. Sharing docs between accounts needs a different key model.
- Cross-device latency is bounded by the poll timer (30s, backing off to 5 min). A payload-free "poke" over SSE, WebSocket or web push could trigger `flush()` without the server seeing data.

## Target shape

| Package | Contents |
|---|---|
| `vault-shared` | Wire schemas, size limits, ID generation and isomorphic helpers (`src/shared/vault/` today) |
| `vault-client` | Crypto, keyring and biometrics; worker engine (`/worker` subpath); main-thread client |
| `vault-server` | Services, driver interface, Dynamo driver, tRPC routers and auth middleware |

Flock keeps its item schemas, the codec and hooks, reminders and the notifier, the store adapter and legacy migrations.

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
  - After a deprecation window, run the `removeLegacyAccountMetadata` migration, then delete the legacy procedures, `LegacySettingsSource`, `legacySettings.ts` and `FlockAccountFieldsSchema.metadata`.
- [x] 2.2: Snapshots no longer carry a plaintext `type`, and `DocCodec.snapshotKind` is gone. The server stops requiring `metadata.type`, and each new snapshot write replaces the whole `metadata` map, so it drops the field. Run the `removeItemTypeMetadata` migration to strip it from older rows. Deploy the server before the client: the old server rejects snapshots without `type`, while the new one ignores the `type` that cached old clients still send.

### Stage 3: workspaces

Move the library zones into `packages/*`, rewrite `src/...` alias imports and move the tests with them.

### Stage 4: publish

Only once a second app uses it.
