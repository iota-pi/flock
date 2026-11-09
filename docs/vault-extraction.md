# Vault Library and Backwards Compatibility

The vault (client-side encrypted, local-first, near real-time sync) is a library in three Yarn workspaces under `packages/`, so that other apps can use it. [AGENTS.md](../AGENTS.md) lists the packages, their entry points and the import rules. [sync-design.md](sync-design.md) explains the engine; its rules are the library's invariants. This file covers how Flock plugs in, and how data formats are retired.

## The library boundary

- **The library knows nothing about Flock.** Flock supplies its item schemas through a `DocCodec`, its domain through `SyncDomain` hooks (`packages/vault-client/src/worker/domain.ts`), its store and telemetry through `SyncStateSink` and `SyncTelemetry`, and its session callbacks through `configureVaultHost` (`packages/vault-client/src/client/host.ts`). The app owns the worker entry file, because the worker and Automerge's wasm are loaded with bundler-specific imports.
- **Storage names are configuration.** Every IndexedDB database, BroadcastChannel, Web Lock and localStorage key comes from `VaultStorageNames`. **Flock's names must never change**, or users lose local docs and the cached keyring; `src/app/vault/storageNames.spec.ts` pins them. The names live on `globalThis` (under a `Symbol.for` key), because they belong to the realm and must survive tests that reset modules.
- **The main-thread client takes a sink, not event listeners.** Some handling reads state back (quota recovery checks the current status and warning), and a sink keeps that policy in the library.
- **Keys.** The keyring is a `Keyring` class. The main thread keeps one; the sync worker owns another, loaded from `exportKeyringData`, and hands it to its components as a `KeyProvider`.
- **`@vault/server` is a peer dependency of `@vault/client`,** whose source may import only its types, so the client never loads server code at runtime. There's no test-utilities entry, because it would make vitest a dependency of the package.
- **Not published yet.** That waits for a second app.

### Scope limits

- One user, many devices. Sharing docs between accounts needs a different key model.
- Cross-device latency is bounded by the poll timer (see "Snapshot sync" in sync-design.md). A payload-free "poke" over SSE, WebSocket or web push could trigger `flush()` without the server seeing data.

## Backwards compatibility

Format changes must not leave legacy code in the main app indefinitely. Each one is moved to a separate **migration app** for accounts and devices that stayed away too long, and deleted once nobody needs it.

### Shape

- **Hooks in the library, implementations in Flock.** The library reads and writes only current formats. Each legacy format gets a generic hook (`LegacySettingsSource`, `decodeLegacyItem`, `migrateLocalData`, `decodeLegacySalt`, `deriveLegacyKey`), and Flock implements them in the migration app (`src/migrate/legacy/`). The migration app is rebuilt against the current library, so these hook signatures have to stay stable. The main app may import only `src/migrate/detection.ts`, and lint enforces this.
- **Migration levels.** A level is a numbered set of migrations (`src/shared/flockDataVersion.ts`). Two markers record how far migration has got, with separate minimums (`MIN_DEVICE_DATA_VERSION`, `MIN_ACCOUNT_DATA_VERSION`), because a level can change only one of them:
  - The **account level** (`dataVersion` on the account record) describes the server's data. `accounts.raiseDataVersion` asks the app's `DataVersionPolicy` (`src/vault/flockDataVersion.ts`) for blockers, checking the account's rows itself (`listItemFormats` projects each item's format without its payload), and raises the level with a condition that never lowers it. `getSecurityParams` returns it, because the app has to decide where to send the user before deriving keys. New accounts start at `FLOCK_DATA_VERSION`.
  - The **device level** (`deviceDataVersion` in the account's sync metadata, because the worker writes it and workers have no localStorage) describes local data. `DataVersionTracker` writes it after a manifest sync without failures, by which point the session has run every local migration. A device with no vault data starts at the current level.
- **Old builds.** A device that has been away loads its cached build first. Every tRPC client sends `x-vault-protocol: VAULT_PROTOCOL_VERSION`, and the server rejects mutations below `MIN_PROTOCOL_VERSION` (`src/vault/api/index.ts`, which lists what each version retired) with `PRECONDITION_FAILED`/`CLIENT_OUTDATED`; queries stay open. The client broadcasts it on the vault events channel, and Flock's handler (`src/app/vault/clientOutdated.ts`) forces the service worker update, or reloads, at most once every five minutes before asking the user to. Normally a new version waits for the user to tap Reload (`registerType: 'prompt'`), because the reload locks the vault in every open tab. Server shims kept only for old builds go when the minimum is raised.
- **Destructive cleanups wait.** A server migration that removes data a legacy path still reads runs only once its level is retired.

### The migration app

A second page of Flock's Vite build (`migrate/index.html` → `src/migrate/main.tsx`), served at `/migrate/`. It must be same-origin, because local data is per origin; it ships in the same deploy and the service worker precaches it.

- **Its worker** (`migrate.worker.ts`) runs the main app's engine and domain plus every legacy hook, `upgradeSnapshotFormat`, and `fetchManifestEverySync` (otherwise a device that synced within `manifestSyncMinGap` would skip the manifest and never see a legacy row).
- **Flow:** it logs in (online only), announces itself on the `flock-migration` BroadcastChannel so the main app's tabs lock and its engine is the only one running, runs the levels' migrations, polls `SyncApi.checkDataVersion` until both levels reach their minimums, then clears legacy local stores, locks and returns to `/`.
- **Blockers that remain** once sync has settled (such as an item that won't decrypt, quarantined to manual recovery) are listed, with **Try again** (a full resync) and **Continue**, which defers the main app's account-level check on this device for 30 days (`deferMigration`).
- **Server:** its legacy procedures are in the `migration` router (`src/vault/trpc/routers/migration.ts`).
- **Testing by hand:** `scripts/seedLegacyAccount.ts` puts a local account back at level 0.

The main app sends data below a minimum to `/migrate/` (`goToMigration`) from four places:

- **The worker** (`SyncWorkerConfig.minDataVersion`): below it, a device with an index or with legacy local data (`hasLegacyLocalData`) doesn't start. It emits `migrationRequired`, and `initRepo` rejects with `MigrationRequiredError`. This runs first in `initialize`, because starting would record the current level for a device whose only data is in a legacy layout.
- **The hydrator:** with no `decodeLegacyItem`, a row without a snapshot is reported as `migration_required`, skipped rather than quarantined, and the sync doesn't count as complete.
- **The login page:** when `getSecurityParams` reports an account level below the minimum, or no Argon2id parameters, it routes before deriving keys (unless deferred), and also on `UnsupportedKeyDerivationError` from cached parameters during an offline login.
- **After every unlock** (`useAccountLevelCheck`): once online, because an offline login and a biometric unlock skip the login page's check.

### Retiring a level

Retire a level once `countAccountsByDataVersion` (a read-only server migration that reports accounts by level, what holds back those below, and the oldest `lastAccess` among them) shows none left, or the rest are accepted as abandoned. `lastAccess` is set at login and when a session is renewed. Then run the level's destructive cleanups and delete its code from the migration app. Device levels can't be scanned, because the server can't see them.

## Levels

### Level 1: legacy formats

Blockers (`flockDataVersionPolicy`, which reports every level's blockers together): synced settings in the record's plaintext `metadata` (`legacySettings`), and among rows that aren't deleted, an unbound snapshot (`unboundSnapshots`) or a `cipher` row without a `snapshot` (`legacyCipherItems`). Deleted rows don't count, because hydration never decrypts them.

- **Plaintext account settings.** Settings now live in the encrypted account settings document (see sync-design.md). Only a client can encrypt, so after each manifest sync `AccountSettings.migrateLegacySettings` copies the app's `LegacySettingsSource` (the server's plaintext copy merged with the device's by `updatedAt`) into keys the document lacks, then clears the source. The device level counts this done once the synced keys are gone from local metadata.
- **Unbound ciphertexts** (see "Doc-bound ciphertexts" in sync-design.md). `SnapshotFormatUpgrade` rewrites them, and only the migration app runs it. The main app still *reads* unbound ciphertexts, because older snapshots can be unbound.
- **Pre-Automerge `cipher` items.** `SyncDomain.decodeLegacyItem` decodes a row with **no snapshot** (Flock's is `src/migrate/legacy/legacyItems.ts`), and the engine stores the result as a new document marked dirty, so a bound snapshot is uploaded at once. A row whose snapshot won't decrypt is quarantined, never decoded from `cipher`, which would replace the newer snapshot with pre-Automerge content. A snapshot write removes `cipher` from the row; a payload-less tombstone keeps it, since deleted rows are never read.
- **Old salt encoding.** Salts from before `saltVersion` 1 were fed to PBKDF2 as the UTF-8 bytes of the base64 string. Re-deriving needs the password, so the server can't migrate them. The migration app passes `decodeLegacySalt` so such accounts can log in, and level 2's password change replaces the salt.
- **Old local layouts.** `migrateLocalData` (`src/migrate/legacy/localData.ts`) imports Flock's per-store databases and older keys and value shapes, copying a value only when the new key is missing and only then removing the old one, so concurrent tabs are safe. Dropping it without a migration path would lose the index on devices that haven't run the app since the consolidation, and their unsynced items would never sync.

Still to do: retire the level. That allows the main app to stop reading unbound ciphertexts and the server to reject unbound writes, and runs the cleanups that wait for it: `removeLegacyAccountMetadata` (and `metadata` in `FlockAccountFieldsSchema`), removing leftover `cipher` fields, dropping `LegacyItemEnvelopeSchema` from the library, and dropping the server's `salt ?? account` fallback in `getSecurityParams` once `countAccountsByDataVersion` reports no account without a `salt`.

### Level 2: Argon2id and random data keys

Part 1 of [local-encryption.md](local-encryption.md). Blockers: `legacyKeyDerivation` (no Argon2id `kdf`) and `passwordDerivedDataKey`. It changes only account data and goes straight to the migration app, because the account must choose a new password there.

### Level 3: sealed local data

Part 2 of [local-encryption.md](local-encryption.md). It changes only device data.
