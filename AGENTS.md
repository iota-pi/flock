# Flock Architecture Guide

Flock is a prayer-tracking Progressive Web App (PWA) with end-to-end encrypted sync across devices. It uses a local-first, offline-capable architecture built on Automerge CRDTs with server-side persistence to AWS.

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, MUI 9, Zustand, React Router 7 |
| Build | Vite, TypeScript 6, Vitest, Cypress |
| CRDT | Automerge (WASM) + automerge-repo |
| Local Storage | IndexedDB (via localforage + custom adapter) |
| Server | Fastify + tRPC, deployed as AWS Lambda via SST |
| Database | DynamoDB (3 tables: accounts, items, sync messages) |
| Infrastructure | SST v4, AWS (ap-southeast-2), Cloudflare DNS |
| Auth | Session-based with encrypted vault keys |
| Encryption | Client-side AES encryption with versioned key rotation |

## Project Structure

```
src/
├── api/                    # Client-side API layer
│   ├── vault/              # Vault client functions (crypto, keyring, auth)
│   │   ├── index.ts        # Core vault API (encrypt/decrypt, key management)
│   │   ├── SyncWorkerClient.ts  # Sync API calls (pushBatch, pollSync, putSnapshots)
│   │   ├── ItemClient.ts   # Item/manifest fetching
│   │   └── AccountClient.ts # Account management
│   ├── trpcClient.ts       # tRPC client setup
│   └── runtime.ts          # Runtime API config (auth token, base URL)
├── app/                    # Route/page components
├── components/             # Shared UI components
├── features/               # Feature modules (items, groups)
├── hooks/                  # React hooks
├── state/                  # Zustand store
│   ├── store.ts            # Root store (composed slices)
│   ├── items.ts            # Item types and schemas
│   ├── selectors.ts        # Derived state selectors
│   └── slices/             # Store slices (syncSlice, etc.)
├── shared/                 # Shared types, schemas, error classes
├── sync/                   # ★ Sync system (see detailed section below)
├── vault/                  # Server-side code (runs in Lambda)
│   ├── api/                # Fastify server setup
│   ├── trpc/routers/       # tRPC route handlers (accounts, items, sync)
│   ├── services/           # Business logic (automergeSyncService, manifestService)
│   ├── drivers/            # DynamoDB driver (data access layer)
│   └── migrations/         # Schema migrations
├── service-worker.ts       # PWA service worker (Workbox)
├── App.tsx                 # Root component
└── index.tsx               # Entry point
```

## Sync System Architecture

The sync system is the most complex part of the codebase. It runs in a **dedicated Web Worker** and communicates with the main thread via Comlink RPC and MessagePort event channels.

### High-Level Data Flow

```
User Edit → Automerge Doc Change → Two parallel paths:
  1. Incremental: VaultNetworkAdapter → WAL → SyncPoller → Server push
  2. Snapshot:    markItemDirty → SnapshotManager → Server snapshot upload

Server → Two inbound paths:
  1. Incremental: SyncPoller pull → SyncPullQueueManager → Automerge merge
  2. Full state:  ManifestSyncManager → fetch snapshots → hydrate Automerge docs
```

### Sync Directory Layout

```
src/sync/
├── client/                           # Main-thread side
│   ├── SyncBridge.ts                 # Main-thread ↔ Worker bridge (Comlink wrapper)
│   ├── useSyncCoordinatorLifecycle.ts # React hook managing worker lifecycle
│   ├── syncWorkerHealth.ts           # Heartbeat + crash detection + auto-restart
│   └── realtimeBus.ts                # BroadcastChannel for cross-tab item update pings
├── shared/                           # Shared between main thread and worker
│   ├── VaultPersistence.ts           # Legacy sync batch persistence (IndexedDB)
│   ├── manualRecoveryStore.ts        # Quarantine store for items that fail decryption
│   ├── workerAuthStore.ts            # Auth token accessor for the worker
│   └── legacyTypes.ts                # Legacy type definitions
├── worker/                           # Web Worker side (runs in sync.worker.ts)
│   ├── sync.worker.ts                # Worker entry point, Comlink API surface
│   ├── SyncWorkerContext.ts          # Wires all worker components together
│   ├── SyncOrchestrator.ts           # Leader election + poll scheduling + backoff
│   ├── SyncMessageBroker.ts          # Routes messages between adapter ↔ WAL ↔ poller
│   ├── SyncPoller.ts                 # Executes poll cycles (push WAL + pull new data)
│   ├── SyncPullQueueManager.ts       # Tracks per-item pull cursors, processes inbound
│   ├── SyncWriteAheadLog.ts          # Durable queue of outbound Automerge sync messages
│   ├── WalEntryQuery.ts              # Query abstraction over WAL entries encapsulating in-flight filtering
│   ├── SyncStatusManager.ts          # Computes sync status for the UI
│   ├── SyncEventHub.ts               # Typed event emitters (client ↔ worker internal)
│   ├── SnapshotManager.ts            # Debounced full-snapshot push to server
│   ├── snapshotBuilder.ts            # Builds encrypted snapshot from Automerge doc
│   ├── ManifestSyncManager.ts        # Full-state sync via server manifest comparison
│   ├── ItemOperations.ts             # CRUD on Automerge documents + manual recovery
│   ├── AutomergeRepoManager.ts       # Creates/configures the Automerge Repo instance
│   ├── VaultEncryptedNetworkAdapter.ts    # Automerge network adapter for server sync
│   ├── EncryptedBroadcastChannelNetworkAdapter.ts  # Encrypted cross-tab sync adapter
│   ├── FlockIndexedDBStorageAdapter.ts    # Custom IndexedDB storage for Automerge
│   ├── reencryptAllItems.ts          # Key rotation: re-encrypt all items
│   ├── docStore/                     # Automerge document management
│   │   ├── AutomergeDocStore.ts      # Find/create/change/hydrate Automerge documents
│   │   ├── AutomergeIndexManager.ts  # Account-level item index document
│   │   └── index.ts                  # Re-exports + normalizeItemSnapshot
│   ├── stores/                       # Localforage-backed stores
│   │   ├── CursorStore.ts            # Persists pull cursors
│   │   ├── IndexStore.ts             # Persists index document
│   │   └── LastModifiedStore.ts      # Persists last-modified timestamps
│   └── utils/
│       ├── AsyncQueue.ts             # Sequential FIFO async queue with in-flight safety
│       ├── LeaderElection.ts         # navigator.locks-based leader election
│       ├── automerge.ts              # URL/ID conversion helpers
│       ├── binaryFraming.ts          # Length-prefixed batched message framing & packing
│       ├── messageParser.ts          # Length-prefixed batched message parser
│       └── snapshot.ts               # Snapshot type normalization
└── utils/                            # (currently empty)
```

### Key Sync Concepts

#### Dual Sync Paths

The system has two complementary server sync mechanisms:

1. **Incremental Sync (WAL → SyncPoller)**: Individual Automerge sync messages are appended to the Write-Ahead Log when documents change. The SyncPoller reads WAL entries, encrypts them, and pushes them via `pollSyncBatchWithToken`. This provides fast, fine-grained sync. WAL entries are removed after successful server acknowledgment.

2. **Snapshot Sync (SnapshotManager)**: Full Automerge document binaries are periodically serialized, encrypted, and uploaded to the server. This provides a recovery baseline and a fallback for devices that missed incremental messages. Debounced (30s default, 5min max wait).

**Important**: The local Automerge document (in IndexedDB) always holds the complete, authoritative state of each item, regardless of what is queued in the WAL or snapshot pipeline. The WAL and snapshots are delivery mechanisms, not the source of truth.

#### Leader Election and Multi-Tab

Only one tab performs server sync at a time. `LeaderElection` uses `navigator.locks` to elect a leader. The leader tab runs the `SyncOrchestrator` polling loop; follower tabs still have a running Automerge Repo but rely on the `EncryptedBroadcastChannelNetworkAdapter` for cross-tab document sync.

#### Offline and Reconnection

- Documents are stored locally in IndexedDB via `FlockIndexedDBStorageAdapter`, so the app works fully offline.
- The `SyncOrchestrator` tracks online state; when offline, polling stops and the `SnapshotManager` halts retries.
- On reconnection, the orchestrator resets backoff and triggers an immediate poll, pushing any queued WAL entries and pulling server updates.
- `ManifestSyncManager` runs periodically (daily, or every 7 days if forced) to reconcile the local item set against the server's manifest, fetching any missing/updated snapshots.

#### Encryption

All data is end-to-end encrypted client-side before leaving the browser:
- `encryptBytes` / `decryptBytes` in `src/api/vault/index.ts` handle AES encryption with versioned keys (`kver`).
- Encryption keys are derived from the user's password and stored in-memory in the vault keyring.
- Key rotation triggers `reencryptAllItems`, which re-encrypts and re-uploads all snapshots with the new key.
- Cross-tab sync messages are also encrypted via `EncryptedBroadcastChannelNetworkAdapter`.
- The server (lambda) cannot and does not decrypt the Automerge binaries. This means that no Automerge merging or reconcillition happens server-side. The server is a "dumb" relay.

#### Cross-Tab Sync & Missing Key Queueing (Intentional Inline Wait)

`EncryptedBroadcastChannelNetworkAdapter` handles cross-tab Automerge sync using encrypted messages tagged with the active key version (`kver`).

When a tab receives a message encrypted with a key version not yet in its keyring (`!hasVaultKey(kver)`):
- The receive queue pauses inline (`await waitForKeyVersion(kver, timeout)`) while firing `onKeyVersionMissing(kver)` to prompt the main thread to reload the keyring from storage or the server.
- **Why this is intentional and NOT a head-of-line blocking bug**:
  - **Rare trigger**: All tabs share the active key version during normal operation. A missing key version occurs *only* during key rotation or password change.
  - **Typically resolves in milliseconds**: When key rotation occurs, the new key propagates across tabs via `localStorage` and `VAULT_EVENTS_CHANNEL` almost instantly. `waitForKeyVersion` resolves as soon as the key arrives (typically 10–50ms), allowing the normal fast path to decrypt in-place without queueing churn.
  - **Preserves causal ordering**: Pausing briefly ensures incoming messages for the document are not interleaved or processed out-of-order during the key transition.
  - **Subsequent messages need the same key anyway**: If Tab A rotated to a new key version, virtually all subsequent messages from Tab A are encrypted with that same new key. Jumping the queue would not help because subsequent messages would also be blocked waiting for that key.
  - **Fallback unblocking prevents permanent stalls**: If the key cannot be acquired within `keyWaitTimeoutMs` (default 5s, e.g. offline during remote key rotation), the message is buffered into `pendingKeyMessages`, background resolution is handed off to `waitForKeyAndDrain`, and the main receive queue resumes processing. No messages are dropped.
  - **Durable safety**: Cross-tab BroadcastChannel sync is an ephemeral peer-to-peer optimization. Local IndexedDB documents and server sync remain the durable source of truth.

#### Error Recovery

- **Manual Recovery Store**: Items that fail decryption are quarantined in `manualRecoveryStore` (IndexedDB) and surfaced to the user for manual intervention.
- **SyncPullQueueManager retry**: Failed pull messages are retried up to `MAX_PULL_RETRIES` (5) before quarantining the item.
- **SnapshotManager retry**: Failed snapshot pushes use exponential backoff (2s → 5s → 10s → 30s → 60s). After `MAX_CONSECUTIVE_SNAPSHOT_FAILURES` (5), the item is removed from the dirty queue.
- **Worker crash recovery**: `syncWorkerHealth.ts` monitors the worker via heartbeat ping/pong (15s interval, 30s timeout). On crash, the worker is auto-restarted up to `MAX_CONSECUTIVE_CRASHES` (3).

#### Deletion Architecture & Tombstone Lifecycle (No ID Recycling)

Flock intentionally uses **soft-deletes (tombstones)** across both client and server; there is **no server-side hard-delete**:
- Item deletions set `deleted: true` on the Automerge CRDT document and propagate this tombstone via incremental sync messages and snapshot uploads (`metadata.deleted = true`).
- DynamoDB records in `FlockItems` are never hard-deleted and have no TTL.
- In a local-first offline architecture, an item missing from the server manifest indicates it was created offline and needs an upstream push—not that it was deleted. If an item were hard-deleted on the server, `ManifestSyncManager`'s two-way upstream reconciliation would treat it as an offline item and resurrect/re-upload it.
- UI selectors filter out tombstoned items (`!item.deleted`), and `AutomergeIndexManager` excludes them from the active item ID index.
- **Deletions are terminal (no undelete / no ID recycling)**: Flock does not support undeleting items; deletions cannot be undone. Creating an item with the same name generates a brand-new random Nanoid (`generateItemId()`, 126 bits of entropy).
- **Why "Delete + Recreate with the same ID" is impossible and intentional**:
  - In a CRDT, reusing an existing document ID for a new logical entity is an anti-pattern because Automerge would merge the old entity's edit history and tombstones into the new entity.
  - `AutomergeDocStore.findOrCreateHandle` explicitly refuses to create a blank document if data already exists in storage (`hasDataInStorage(itemId)`). This is a vital **data loss prevention safety guard** to ensure transient handle lookup timeouts never overwrite an existing local document.
  - Accidental ID collisions between new items and soft-deleted items are statistically impossible ($< 10^{-18}$ probability).

#### DynamoDB Cursor Generation & Collision Safety

Incremental sync cursors in `automergeSyncService` are generated as `relativeTimestampSeconds * 10_000_000 + random(0, 9_999_000)`:
- **Partition isolation**: The `FlockSyncMessages` primary key is `syncId` (`${account}#${itemId}`) + `cursor`. Pushes for different items or accounts never collide, even if they share the exact same cursor value.
- **Negligible collision probability**: A collision requires two devices on the *same* account editing the *exact same item* within the *exact same 1-second window* and choosing the exact same random offset ($P \approx 10^{-7}$, $\sim 1\text{ in }10,000,000$).
- **Non-monotonic pull safety**: Random offsets mean cursors within a 1-second bucket are not strictly chronological. Pull queries apply an intentional lookback buffer (`OVERLAP_WINDOW_SECONDS = 10` / `OVERLAP_CURSOR_DELTA = 100_000_000`) so clients never skip out-of-order cursors.
- **Snapshot recovery safety**: In the negligible event of an overwrite during `BatchWriteCommand`, permanent data loss is prevented because local Automerge documents in IndexedDB are authoritative and `SnapshotManager` periodically syncs full document snapshots to `FlockItems`.

#### Snapshot Uploads: Intentional LWW and Absence of OCC

In `itemsRouter.putSnapshots`, snapshot writes to `FlockItems` omit `item.version`, making them unconditional Last-Write-Wins (LWW) overwrites in DynamoDB without Optimistic Concurrency Control (OCC):
- **Why this is intentional and NOT a data-loss vulnerability**:
  - **Local CRDT authority**: Automerge documents in local IndexedDB are the durable source of truth. DynamoDB snapshots are recovery baselines and fallbacks, not authoritative documents. Overwriting a snapshot in DynamoDB never modifies or reverts a client's local document.
  - **Incremental sync safety**: All edits are independently captured and retained for 90 days as granular sync messages in `FlockSyncMessages`. Clients catch up through incremental sync regardless of snapshot arrival order.
  - **Non-destructive CRDT hydration**: When any client pulls a snapshot (`AutomergeDocStore.hydrateAutomergeDocumentBinary`), it performs a CRDT merge (`existingHandle.merge(incomingHandle)` or `Automerge.merge(localDoc, incomingDoc)`), not a raw overwrite. Because CRDT merges are monotonic semilattices ($\text{merge}(A+B, A) = A+B$), an older snapshot cannot clobber newer edits.
  - **Automatic baseline self-healing**: If a client receives an older snapshot during `ManifestSyncManager` reconciliation, `hydrationResult.hasLocalChanges` evaluates to `true`. This immediately triggers `markItemDirty`, causing the client to upload a fresh snapshot with the merged state back to DynamoDB.
  - **Why OCC on snapshots would be harmful**: The server is a zero-knowledge relay and cannot decrypt or merge CRDTs. If OCC (`ConditionalCheckFailedException`) were enforced on snapshot writes, concurrent/offline snapshot flushes would conflict, causing retry churn and eventually false-quarantining healthy items into `manualRecoveryStore`. (Flock reserves OCC strictly for centralized, non-CRDT operations like `keyringVersion` during key rotation.)

## Server-Side Architecture

The server is a Fastify app with tRPC routers, deployed as an AWS Lambda behind a Function URL:

- **DynamoDB Tables**:
  - `FlockAccounts` — account records (hash: `account`)
  - `FlockItems` — item metadata + encrypted ciphers (hash: `account`, range: `item`, GSI: `account` + `modifiedAt`)
  - `FlockSyncMessages` — incremental Automerge sync messages (hash: `syncId`, range: `cursor`, GSI: `account` + `cursor`, TTL: `expiresAt`)
- **tRPC Routers**: `accounts`, `items`, `sync` — handle account CRUD, item CRUD, and sync push/pull operations

## State Management

The app uses **Zustand** with composed slices. The store is in `src/state/store.ts`. The sync-relevant slice is `syncSlice.ts` which tracks:
- `syncStatus`: `'idle' | 'connecting' | 'syncing' | 'offline' | 'degraded' | 'dead'`
- `fatalError` / `syncWarning`: user-facing error messages
- `generation`: incremented on full data reloads to trigger React re-renders

Item data flows from Automerge docs (in the worker) → dispatched via `SyncEventHub` as `itemUpdated` / `allItemsLoaded` events → received by `SyncBridge` on the main thread → written to the Zustand store.

## Testing

- **Unit tests**: Vitest, co-located as `*.spec.ts` files. Most sync components have dedicated specs.
- **Integration tests**: `sync.integration.spec.ts` tests the WAL → poll → pull cycle with mocked network/storage.
- **E2E tests**: Cypress (`cypress/e2e/`): `offline-sync.cy.ts`, `offline-recovery.cy.ts`, `keyring-sync.cy.ts`.

## Development

```bash
yarn start          # Runs both Vite dev server + vault API server (with Docker DynamoDB)
yarn dev            # Vite dev server only
yarn dev:vault      # Vault API server only (tsx watch)
yarn test           # Vitest
yarn e2e            # Cypress
yarn build          # Production build
yarn deploy         # SST deploy
```
