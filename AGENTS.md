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
│   └── syncWorkerHealth.ts           # Heartbeat + crash detection + auto-restart
├── shared/                           # Shared between main thread and worker
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
│   ├── BaseSyncNetworkAdapter.ts     # Abstract base NetworkAdapter encapsulating peer connection & dispatch
│   ├── VaultNetworkAdapter.ts    # Automerge network adapter for server sync
│   ├── EncryptedBroadcastChannelNetworkAdapter.ts  # Encrypted cross-tab sync adapter
│   ├── FlockIndexedDBStorageAdapter.ts    # Custom IndexedDB storage for Automerge
│   ├── reencryptAllItems.ts          # Key rotation: re-encrypt all items
│   ├── realtimeBus.ts                # Account-scoped BroadcastChannel for cross-tab item update pings
│   ├── docStore/                     # Automerge document management
│   │   ├── AutomergeDocStore.ts      # Find/create/change/hydrate Automerge documents
│   │   ├── AutomergeIndexManager.ts  # Account-level item index document
│   │   └── index.ts                  # Re-exports + normalizeItemSnapshot
│   ├── stores/                       # Localforage-backed stores
│   │   ├── syncMetadataStorage.ts    # Consolidated IndexedDB database manager & migration
│   │   ├── CursorStore.ts            # Persists pull cursors ('cursors' key)
│   │   ├── IndexStore.ts             # Persists index document ('indexDoc' key)
│   │   ├── LastModifiedStore.ts      # Persists last-modified timestamps ('lastModified' key)
│   │   └── SyncedHeadsStore.ts       # Persists synced heads for sync adapter ('syncedHeads' key)
│   └── utils/
│       ├── AsyncQueue.ts             # Sequential FIFO async queue with in-flight safety
│       ├── LeaderElection.ts         # navigator.locks-based leader election
│       ├── automerge.ts              # URL/ID conversion helpers
│       ├── binaryFraming.ts          # Length-prefixed batched message framing & packing
│       ├── errorClassifier.ts        # Centralized single-pass error classification (ErrorClassifier)
│       ├── messageParser.ts          # Length-prefixed batched message parser
│       └── snapshot.ts               # Snapshot type normalization
└── utils/
    ├── AsyncMutex.ts                 # Sequential FIFO mutual exclusion (AsyncMutex & KeyedAsyncMutex)
    ├── RetryStrategy.ts              # Configurable delay schedules, jitter, and max attempts
    ├── SingleFlightGuard.ts          # Concurrency deduplicator for async operations (SingleFlightGuard & KeyedSingleFlightGuard)
    └── SizeAwareBatchAccumulator.ts  # Generic size- and count-aware batch accumulator
```

### Key Sync Concepts

#### Dual Sync Paths

The system has two complementary server sync mechanisms:

1. **Incremental Sync (WAL → SyncPoller)**: Individual Automerge sync messages are appended to the Write-Ahead Log when documents change. The SyncPoller reads WAL entries, encrypts them, and pushes them via `pollSyncBatchWithToken`. This provides fast, fine-grained sync. WAL entries are removed after successful server acknowledgment.

2. **Snapshot Sync (SnapshotManager)**: Full Automerge document binaries are periodically serialized, encrypted, and uploaded to the server. This provides a recovery baseline and a fallback for devices that missed incremental messages. Debounced (30s default, 5min max wait).

**Important**: The local Automerge document (in IndexedDB) always holds the complete, authoritative state of each item, regardless of what is queued in the WAL or snapshot pipeline. The WAL and snapshots are delivery mechanisms, not the source of truth.

#### WAL Pruning & Snapshot Recovery Safety

When the WAL exceeds `MAX_ENTRIES`, `performPruneOldest` removes older entries to reclaim space. This is safe because:
- **Pruning never loses local data**: The Automerge document in IndexedDB is the authoritative state. WAL entries are outbound delivery messages, not the source of truth.
- **Snapshot sync provides full-state recovery**: `SnapshotManager` periodically serializes and uploads complete Automerge document binaries. Even if WAL entries for an item are pruned before being pushed, the next snapshot upload captures the complete merged state.
- **WAL compaction self-heals torn state**: If the worker crashes mid-compaction, `readAll()` detects entries referenced in a loaded entry's `replaces` array and filters/purges them, preventing duplicate or orphaned entries.
- **In-flight safety**: `SyncPoller.executePoll` wraps the polling cycle in `try/finally`, guaranteeing `wal.unmarkInFlight` runs regardless of errors. Entries cannot get permanently stuck in-flight.

#### AutomergeDocStore
- The AutomergeDocStore class intentionally tightly couples with the Automerge Repo to ensure handle safety to prevent data loss

#### DocHandle Listener Contract

`sync.worker.ts` subscribes to Automerge `DocHandle` `change` events to emit `itemUpdated` events to the UI. The registered listener function reference must be the **exact same reference** used for both `.on()` and `.off()`. Wrapping the listener in an anonymous arrow and storing the inner function causes `.off()` to silently fail, leaking listeners.

#### Server Pull Result Filtering

In `pollSync`, items present in `pullCursors` (targeted per-item pulls) are filtered out from the `globalPullResult` (account-wide pull) to prevent cursor jumps. This is safe:
- If `globalPullResult` truncates messages for an active item, the item's individual `batchPullResult` reports `hasMore: true` and returns a `lastEvaluatedKey`. The client requests the remaining messages via individual `pullCursors` on the next poll.
- Pull cursors advance monotonically. `SyncPullQueueManager` sorts messages ascending and `break`s on parse failure, ensuring the cursor only advances to the last successfully processed message.

#### Leader Election and Multi-Tab

Only one tab performs server sync at a time. `LeaderElection` uses `navigator.locks` to elect a leader. The leader tab runs the `SyncOrchestrator` polling loop; follower tabs still have a running Automerge Repo but rely on the `EncryptedBroadcastChannelNetworkAdapter` for cross-tab document sync.

**Presence channel & heartbeat protocol:**
- The leader broadcasts periodic heartbeats via a `BroadcastChannel`. Other tabs (including yielded former leaders) listen for these heartbeats to detect multi-leader conflicts and leader crashes.
- Only tabs with `isLeader === true` send heartbeats (`sendHeartbeat` bails if `!this.isLeader`).
- When a leader yields (due to receiving a `claim` from a higher-priority tab), it calls `revokeLeadership(false)` — preserving the presence channel and heartbeat timer so it can still monitor the new leader and recover if it crashes.
- `multipleLeadersDetected` should only fire when there are genuinely 2+ active leaders (not just because a non-leader tab receives heartbeats from the sole active leader).

#### Offline and Reconnection

- Documents are stored locally in IndexedDB via `FlockIndexedDBStorageAdapter`, so the app works fully offline.
- The `SyncOrchestrator` tracks online state; when offline, polling stops and the `SnapshotManager` halts retries.
- On reconnection, the orchestrator resets backoff and triggers an immediate poll, pushing any queued WAL entries and pulling server updates.
- `ManifestSyncManager` runs periodically (daily, or every 7 days if forced) to reconcile the local item set against the server's manifest, fetching any missing/updated snapshots.

#### Consolidated IndexedDB Sync Metadata Database

Flock consolidates all local sync metadata into a single dedicated IndexedDB database per account: `flock-sync-metadata-${accountId}` (object store `sync-metadata`):
- **Eliminates 3 connection pools**: Previously, 4 separate LocalForage stores (`CursorStore`, `IndexStore`, `LastModifiedStore`, `SyncedHeadsStore`) each created their own dedicated IndexedDB database for a single key. All 4 now share a single cached `LocalForage` connection pool per account managed by `getSyncMetadataStorage(accountId)`.
- **Dedicated separate keys**:
  - `cursors` — pull progress per item (`[ItemId, number][]`)
  - `indexDoc` — Automerge account item index document (`AutomergeIndexDocument`)
  - `lastModified` — timestamps of local modifications and snapshots (`[ItemId, ItemSyncTimestamps][]`)
  - `syncedHeads` — tracked Automerge heads for the network sync adapter (`[DocumentId, string[]][]`)
  - `manualRecoveryMigrated` — migration flag for manual recovery store v2 (`boolean`)
- **Seamless legacy migration**: On read, each store checks for the consolidated key first. If absent, it lazily migrates legacy entries from earlier keys or legacy singleton databases (`flock-sync-cursors`, `flock-item-metadata`, `flock-sync-last-modified`, `flock-sync-synced-heads`, or legacy `manual-recovery-metadata`) if they exist on disk, avoiding phantom database creation.
- **Simplified account data wiping**: Account logout or reset wipes the entire consolidated database in one step via `clearSyncMetadataStorage(accountId)` in `clearAccountLocalData`. Store-level `.clear()` calls remain isolated to their respective key.

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

#### Oversized Item Handling (ID Rotation, Not In-Place Compaction)

When an Automerge document's serialized binary exceeds the snapshot size limit (350 KB), the system uses **item recreation with ID rotation** — NOT in-place document compaction:
- **Why in-place compaction is forbidden**: Creating a fresh `Automerge.init()` document under the same `documentId` produces disjoint causal heads. When any peer or server snapshot containing the old history merges, Automerge unions all heads, resurrecting the entire old history. This violates CRDT convergence guarantees.
- **Recreation flow**: `ItemOperations.recreateOversizedItem` generates a new random `ItemId`, creates a clean Automerge document with the latest content (excluding edit history), remaps group memberships from old→new ID, and soft-deletes the old item.
- **Content size validation**: Before recreation, the system validates that the item's current content (excluding Automerge edit history) is under 300 KB. If the content itself is oversized, recreation is rejected — the user must reduce the content manually.
- **`compactItem` is a deprecated alias** for `recreateOversizedItem` and delegates directly to it.

#### Lifecycle Shutdown Order Contract

The sync worker uses `ServiceLifecycleManager` to orchestrate startup/shutdown of all components. The shutdown order matters for data integrity:
- **AutomergeRepo must be shut down BEFORE clearing IndexedDB**: If `clearLocalData()` runs while the repo is active, pending saves can write data back into the cleared database. The repo must be shut down first to prevent data remanence.
- **Database `dropInstance` must not race with `removeItem`**: When clearing the consolidated sync metadata database, `clearSyncMetadataStorage` (which drops the entire database) must not run concurrently with individual store `.clear()` calls that open transactions on the same database.
- **WAL has its own separate IndexedDB database**: `wal.clear()` targets a separate database from the consolidated sync metadata stores and can safely run concurrently with `clearSyncMetadataStorage`.

#### SyncPoller Result Propagation Contract

`SyncPoller.executePoll` returns a result string (`'success'` / `'failure'` / `'noop'`) that controls `SyncOrchestrator`'s backoff behavior:
- **`'success'`**: Resets backoff to minimum interval. Used only when the poll cycle completed without errors.
- **`'failure'`**: Triggers exponential backoff. Must be returned when push or pull processing throws, to prevent tight infinite polling loops.
- **`'noop'`**: No change to backoff. Used when polling was skipped (e.g., no pending work).
- **Critical invariant**: If `processPullResults` or any I/O operation throws inside `executePoll`, the poll **must not** report `'success'`, otherwise the orchestrator resets backoff and `hasImmediatePendingPulls()` may remain true, causing a 0ms re-poll loop.

#### Monotonic Snapshot Revisions & Elimination of Physical Clock Skew

Flock uses **server-assigned monotonic revision tokens (`version`)** for full snapshot synchronization, aligning snapshots with the monotonic cursors already used by transient messages:
- **Server-assigned atomic increment**: When a client persists a snapshot (`persistSnapshots` / `items.putSnapshots`), the DynamoDB driver executes an atomic `UpdateCommand` with `version = if_not_exists(version, 0) + 1` and returns the newly assigned `version`.
- **Preserved LWW & Blind Relay Model**: Snapshot persistence remains unconditional Last-Write-Wins (LWW) without Optimistic Concurrency Control (OCC) rejection. The server never merges Automerge CRDTs (zero-knowledge encryption) and never rejects snapshot writes due to version mismatches.
- **Client Base Version Tracking**: Clients persist the latest confirmed server version as `baseVersion` in the consolidated IndexedDB sync metadata store (`lastModified` record per item).
- **Deterministic Reconciliation in `ManifestDeltaCalculator`**:
  - $V_{\text{server}} > V_{\text{base}}$: Server has a strictly newer revision $\implies$ fetch inbound snapshot and merge into local Automerge doc.
  - $V_{\text{server}} \le V_{\text{base}} \land \text{isDirty}$: Local Automerge doc has unsaved modifications $\implies$ push upstream snapshot.
  - $V_{\text{server}} \le V_{\text{base}} \land !\text{isDirty}$: In sync $\implies$ zero network transfer.
  - Item missing from server manifest: Created locally offline $\implies$ push upstream snapshot.
  - Server tombstone ($V_{\text{server}} > V_{\text{base}} \land \text{isDeleted}$): Item was deleted remotely $\implies$ apply tombstone locally.
- **Physical Clock Skew Elimination**: Because snapshot synchronization relies on monotonic integers rather than physical timestamps, clock skew between client devices and AWS Lambda, fast/slow client clocks, and arbitrary skew buffers (`SKEW_BUFFER_MS`) are completely eliminated from the snapshot reconciliation decision path. Legacy physical timestamps (`localModifiedAt`, `serverTime`) are retained only as fallback metadata.

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

#### DynamoDB Cursor Generation, Collision Safety & Monotonic Pull Progress

Incremental sync cursors in `automergeSyncService` are generated as `relativeTimestampSeconds * 10_000_000 + random(0, 9_999_000)`:
- **Partition isolation**: The `FlockSyncMessages` primary key is `syncId` (`${account}#${itemId}`) + `cursor`. Pushes for different items or accounts never collide, even if they share the exact same cursor value.
- **Negligible collision probability**: A collision requires two devices on the *same* account editing the *exact same item* within the *exact same 1-second window* and choosing the exact same random offset ($P \approx 10^{-7}$, $\sim 1\text{ in }10,000,000$).
- **Strict monotonic cursor progress and removal of OVERLAP_CURSOR_DELTA**:
  - Previously, an artificial 10-second lookback buffer (`OVERLAP_WINDOW_SECONDS = 10` / `OVERLAP_CURSOR_DELTA = 100_000_000`) was applied to pull queries to catch non-chronological offsets within the same 1-second epoch bucket. However, this caused a critical infinite re-download loop: whenever no newer messages arrived, `nextCursor` remained within the lookback window, causing all active clients to perpetually re-download the same batch of messages on every poll interval and burn DynamoDB RCUs (which previously required an in-memory LRU `seenMessageCursors` cache to suppress duplicate CRDT applications).
  - The lookback buffer and client-side LRU cache were completely removed in favor of strict monotonic progression (`#c > :fromCursor` / `:cursor`) and a simple scalar skip in `SyncPullQueueManager` (`cursor <= initialCursor`).
  - **Why strict monotonic queries are safe without lookback**:
    - **Ascending query sorting**: DynamoDB queries return records in ascending cursor order, and the service explicitly sorts messages ascending. All messages available at query time are retrieved in order up to the batch limit, and `nextCursor` advances to the highest cursor returned.
    - **Dual-path snapshot recovery**: In the vanishingly narrow race where a concurrent write with a lower random offset commits *after* a pull query reads a higher offset in the same second, Automerge CRDTs and `ManifestSyncManager` provide the durable recovery baseline. Full document snapshots capture the complete merged state and self-heal any missed incremental messages without requiring artificial query lookbacks in high-frequency polling.
- **Snapshot recovery safety**: In the negligible event of an overwrite during `BatchWriteCommand`, permanent data loss is prevented because local Automerge documents in IndexedDB are authoritative and `SnapshotManager` periodically syncs full document snapshots to `FlockItems`.

#### Snapshot Uploads: Intentional LWW and Absence of OCC

In `itemsRouter.putSnapshots`, snapshot writes to `FlockItems` omit `item.version`, making them unconditional Last-Write-Wins (LWW) overwrites in DynamoDB without Optimistic Concurrency Control (OCC):
- **Why this is intentional and NOT a data-loss vulnerability**:
  - **Local CRDT authority**: Automerge documents in local IndexedDB are the durable source of truth. DynamoDB snapshots are recovery baselines and fallbacks, not authoritative documents. Overwriting a snapshot in DynamoDB never modifies or reverts a client's local document.
  - **Incremental sync safety**: All edits are independently captured and retained for 90 days as granular sync messages in `FlockSyncMessages`. Clients catch up through incremental sync regardless of snapshot arrival order.
  - **Non-destructive CRDT hydration**: When any client pulls a snapshot (`AutomergeDocStore.hydrateAutomergeDocumentBinary`), it performs a CRDT merge (`existingHandle.merge(incomingHandle)` or `Automerge.merge(localDoc, incomingDoc)`), not a raw overwrite. Because CRDT merges are monotonic semilattices ($\text{merge}(A+B, A) = A+B$), an older snapshot cannot clobber newer edits.
  - **Automatic baseline self-healing**: If a client receives an older snapshot during `ManifestSyncManager` reconciliation, `hydrationResult.hasLocalChanges` evaluates to `true`. This immediately triggers `markItemDirty`, causing the client to upload a fresh snapshot with the merged state back to DynamoDB.
  - **Why OCC on snapshots would be harmful**: The server is a zero-knowledge relay and cannot decrypt or merge CRDTs. If OCC (`ConditionalCheckFailedException`) were enforced on snapshot writes, concurrent/offline snapshot flushes would conflict, causing retry churn and eventually false-quarantining healthy items into `manualRecoveryStore`. (Flock reserves OCC strictly for centralized, non-CRDT operations like `keyringVersion` during key rotation.)

#### SyncEventHub Non-Blocking Dispatch & Async Listener Concurrency

`SyncEventHub` (`EventHub`, `ClientEventHub`, and `WorkerInternalEventHub`) implements a synchronous, non-blocking fire-and-forget dispatch pattern:
- **Non-blocking emit**: In `emit(event)`, listeners returning a `Promise` are executed immediately without being awaited. Unhandled promise rejections are caught and logged asynchronously via `.catch()`.
- **Why this design is intentional**:
  - **Unblocks event producers**: Core internal pipelines (such as Automerge Repo network events, WAL appends, pull queue message processing, and heartbeat monitors) are never blocked or throttled by listener I/O latency.
  - **Decoupled latency**: Prevents slow operations (like IndexedDB writes or React main-thread bridge dispatch) from cascading back pressure into sync pipelines.
- **Listener Concurrency Contract**:
  - Because async listeners run concurrently without being awaited by the emitter, listeners must assume that multiple event instances can be in-flight at the same time.
  - Listeners that mutate shared state or require sequential execution are responsible for their own internal synchronization. The codebase uses dedicated concurrency primitives for this purpose:
    - `SingleFlightGuard` / `KeyedSingleFlightGuard` (e.g. `SyncOrchestrator` poll loops, `SnapshotManager` pushes)
    - `AsyncMutex` / `KeyedAsyncMutex` and `ItemLockCoordinator` (e.g. `SyncPullQueueManager.withItemLock`)
    - `AsyncQueue` for sequential FIFO processing
    - Monotonic version/tick counters (e.g. `SnapshotManager.dirtyItemsTick` to invalidate superseded flushes)

## Server-Side Architecture

The server is a Fastify app with tRPC routers, deployed as an AWS Lambda behind a Function URL:

- **DynamoDB Tables**:
  - `FlockAccounts` — account records (hash: `account`)
  - `FlockItems` — item metadata + encrypted ciphers (hash: `account`, range: `item`, GSI: `account` + `modifiedAt`)
  - `FlockSyncMessages` — incremental Automerge sync messages (hash: `syncId`, range: `cursor`, GSI: `account` + `cursor`, TTL: `expiresAt`)
- **tRPC Routers**: `accounts`, `items`, `sync` — handle account CRUD, item CRUD, and sync push/pull operations
- **DynamoDB Batch Limits**: `pushSyncMessagesBatch` uses chunk size 25 (AWS `BatchWriteItem` limit). `fetchSnapshotsByIds` chunks by 100 (AWS `BatchGetItem` limit). `UnprocessedItems` / `UnprocessedKeys` are retried with jittered exponential backoff.
- **Password change invalidates all other sessions**: `changePassword` replaces the `sessions` array with only the current session, forcing all other devices to re-authenticate. This is an intentional security measure.
- **Lambda runs in UTC**: All server-side date operations assume UTC. Client-side timezone conversion uses `date-fns-tz`.

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

## Style
- Utilise the vitest globals in unit tests. Don't import them because it is redundant and will fail the eslint rule
- Don't use increment/decrement operators. Prefer the longer-form `+=` or `-=` syntax
- Don't add re-exports for compatibility after refactoring/moving code. Instead, update the import paths to import from the correct location

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
