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
│       ├── LeaderElection.ts         # navigator.locks-based leader election
│       ├── automerge.ts              # URL/ID conversion helpers
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
