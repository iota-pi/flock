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
- Unit tests are co-located `*.spec.ts` files. Sync integration tests are `src/sync/worker/*.integration.spec.ts`.

## Where things live

- `src/sync/worker/` contains the sync engine, which runs in a Web Worker. `sync.worker.ts` is the Comlink API surface and `SyncWorkerContext.ts` wires the components together.
- `src/sync/client/` is the main-thread side: `SyncBridge`, worker lifecycle and health/restart.
- `src/sync/worker/docStore/` handles Automerge doc find/create/change/hydrate plus the account item index.
- `src/sync/utils/` holds the concurrency primitives (`SingleFlightGuard`, `AsyncMutex`, `AsyncQueue`, `RetryStrategy`, bounded collections). Use them; don't hand-roll new ones.
- `src/api/vault/` is the client crypto, keyring and API calls.
- `src/state/` is the Zustand store (composed slices).
- `src/vault/` is server code: tRPC routers (`accounts`, `items`, `sync`), services and the DynamoDB driver.
- DynamoDB has three tables. `FlockAccounts` is keyed by `account`. `FlockItems` is keyed by `account` + `item`. `FlockSyncMessages` is keyed by `syncId` + `cursor` and has a 90-day TTL.

## Sync: rules that must hold

Read [docs/sync-design.md](docs/sync-design.md) before changing or reviewing anything in `src/sync/` or `src/vault/services/`. It explains why each rule below exists.

1. **The local Automerge doc in IndexedDB is the source of truth.** The WAL (incremental messages) and snapshots (full binaries) only deliver it. The server is a blind relay and never merges.
2. **Never reuse an item ID or recreate a doc under an existing ID.** Deletes are terminal soft-deletes (tombstones). Oversized items (>350 KB) are handled by `recreateOversizedItem` with a new ID, never by in-place compaction. Keep the `hasDataInStorage` guard in `findOrCreateHandle`.
3. **Never hard-delete server items.** Manifest sync would treat a missing item as an offline creation and re-upload it.
4. **`SyncPoller.executePoll` must return `'failure'` if anything threw.** Reporting `'success'` resets backoff and can cause a 0ms re-poll loop.
5. **Shut down the Repo before clearing IndexedDB.** Don't run `clearSyncMetadataStorage` concurrently with per-store `.clear()` calls.
6. **DocHandle listeners must use the same function reference** for `.on()` and `.off()`.
7. **`SyncEventHub.emit` doesn't await listeners.** Async listeners must synchronize themselves.
8. **Snapshot reconciliation compares server-assigned `version` with the local `baseVersion`**, not timestamps.

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
