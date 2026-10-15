# Flock

Flock is a personal pastoral-care (PRM) PWA. It is local-first and works offline, using Automerge CRDTs with end-to-end encrypted sync to an AWS backend. The server never sees plaintext.

**Stack:** React 19, MUI 9, Zustand and React Router 7 on Vite and TypeScript. Automerge + automerge-repo run in a Web Worker and talk to the main thread via Comlink. The server is Fastify + tRPC on Lambda (SST, ap-southeast-2) with DynamoDB.

## Commands

```bash
yarn start            # Docker DynamoDB + Vite + local API server
yarn test run         # Vitest once (plain `yarn test` watches)
yarn typecheck
yarn lint
yarn initdb           # Create local DynamoDB tables (DYNAMODB_ENDPOINT=http://localhost:8000)
yarn e2e              # Cypress (needs `yarn start` running)
```

CI runs `test run`, `typecheck` and `lint` on every PR, so run all three before calling work done.

## Style

- Use vitest globals and don't import them from `vitest`. Type-only imports are allowed, and lint enforces this.
- Don't use `++`/`--`. Write `+= 1`/`-= 1`.
- MUI imports must use the full path (`@mui/material/Button`), not a barrel import (lint enforces this).
- After moving code, update the imports. Don't leave compatibility re-exports behind.
- Unit tests are co-located `*.spec.ts` files. Sync integration tests are `packages/vault-client/src/sync/worker/*.integration.spec.ts`.

## Where things live

The vault (sync engine, client crypto and server) is a reusable library in three Yarn workspaces under `packages/` ([docs/vault-extraction.md](docs/vault-extraction.md)): `@vault/shared`, `@vault/client` and `@vault/server`. They export TypeScript source with no build step. Library code must not import Flock code or undeclared dependencies, and lint enforces this. Flock imports library code only through the packages' entry points: `@vault/shared`, `@vault/client` (main thread), `@vault/client/worker` (the sync worker and the hooks it calls), `@vault/client/storageNames`, `@vault/server` and `@vault/server/dynamo`. When Flock needs something new, export it from one of these rather than adding a deep path. `@vault/client` may only import types from `@vault/server`. Flock plugs in through the interfaces in `packages/vault-client/src/sync/worker/domain.ts` and `packages/vault-client/src/sync/client/host.ts`.

- `packages/vault-client/src/sync/worker/` contains the sync engine, which runs in a Web Worker. `sync.worker.ts` is the Comlink API surface (started with `exposeSyncWorker`) and `SyncWorkerContext.ts` wires the components together.
- `packages/vault-client/src/sync/client/` is the main-thread side: `SyncBridge`, worker lifecycle and health/restart.
- `packages/vault-client/src/sync/worker/docStore/` handles Automerge doc find/create/change/hydrate plus the account item index.
- `packages/vault-client/src/sync/utils/` holds the concurrency primitives (`SingleFlightGuard`, `AsyncMutex`, `AsyncQueue`, `RetryStrategy`, bounded collections). Use them; don't hand-roll new ones.
- `packages/vault-client/src/sync/shared/storageNames.ts` names every IndexedDB database, BroadcastChannel, Web Lock and localStorage key. Flock's names (`src/app/vault/storageNames.ts`, pinned by its spec) must never change. Library specs use `createVaultStorageNames('test')`.
- `packages/vault-client/src/api/` is the client crypto, keyring (`Keyring`, which the worker receives as a `KeyProvider`) and API calls.
- `packages/vault-shared/src/` holds the wire schemas, IDs and size limits shared by client and server.
- `src/app/vault/` is Flock's vault wiring: the worker entry, item codec and hooks, the `SyncBridge` instance and session (lock/remove) flows.
- `src/migrate/` is the migration app, a second page served at `/migrate/`. It holds the compatibility code for legacy formats (`legacy/`) and runs it for devices and accounts below `MIN_DATA_VERSION`, which the main app sends there. The main app may only import `src/migrate/detection.ts`, and lint enforces this. See "Backwards compatibility" in the extraction doc.
- `src/state/` is the Zustand store (composed slices).
- `packages/vault-server/src/` is the vault's server code: tRPC routers (`accounts`, `items`, `sync`), services and the DynamoDB driver. `src/vault/` is Flock's server: `flockAccounts.ts` (reminders, push subscriptions and shims for cached builds), `migration.ts` (the migration app's legacy procedures), `root.ts`, `flockDriver.ts`, `flockDataVersion.ts` (what counts as migrated), the notifier and migrations are Flock's.
- DynamoDB has three tables. `FlockAccounts` is keyed by `account`. `FlockItems` is keyed by `account` + `item`. `FlockSyncMessages` is keyed by `syncId` + `cursor` and has a 90-day TTL.

## Sync: rules that must hold

Read [docs/sync-design.md](docs/sync-design.md) before changing or reviewing anything in `packages/vault-client/src/sync/` or `packages/vault-server/src/services/`. It explains why each rule below exists.

1. **The local Automerge doc in IndexedDB is the source of truth.** The WAL (incremental messages) and snapshots (full binaries) only deliver it. The server is a blind relay and never merges.
2. **Never reuse an item ID or recreate a doc under an existing ID.** Deletes are terminal soft-deletes (tombstones). Oversized items (>350 KB) are handled by `recreateOversizedItem` with a new ID, never by in-place compaction. Keep the `hasDataInStorage` guard in `findOrCreateHandle`. The one exception is the account settings document, whose fixed ID devices may create concurrently; it is never deleted or recreated.
3. **Never hard-delete server items.** Manifest sync would treat a missing item as an offline creation and re-upload it.
4. **`SyncPoller.executePoll` must return `'failure'` if anything threw.** Reporting `'success'` resets backoff and can cause a 0ms re-poll loop.
5. **Shut down the Repo before clearing IndexedDB.** Don't run `clearSyncMetadataStorage` concurrently with per-store `.clear()` calls.
6. **DocHandle listeners must use the same function reference** for `.on()` and `.off()`.
7. **`SyncEventHub.emit` doesn't await listeners.** Async listeners must synchronize themselves.
8. **Snapshot reconciliation compares server-assigned `version` with the local `baseVersion`**, not timestamps.
9. **Encrypt and decrypt snapshots and sync messages with the ID of the item they belong to** (`encryptBytes(bytes, itemId)`, `decryptWithKeyResolution(payload, { docId })`). Every server path must keep the ciphertext's `format` field.

## Intentional designs (don't "fix" or flag these)

- Snapshot uploads are unconditional last-write-wins (LWW) with no OCC. Hydration is a CRDT merge, so stale snapshots are harmless.
- Pull queries are strictly `cursor > from` with no lookback window. A lookback previously caused infinite re-downloads.
- Per-item pulls are filtered out of the global pull result.
- WAL pruning can drop unpushed entries, because snapshots carry the full state.
- The cross-tab adapter waits inline for a missing key version, buffering after 5s.
- Random cursor offsets can collide, but only within the same item and the same second.
- Password change invalidates all other sessions.
- Oversized deleted items upload a payload-less tombstone snapshot.
- Lambda runs in UTC. The client converts with `date-fns-tz`.
