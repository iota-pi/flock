# Sync Design Notes

Background and rationale for the sync system (`packages/vault-client/src/sync/`, `packages/vault-server/src/services/`). [AGENTS.md](../AGENTS.md) lists the rules. This file explains why they exist. Read the relevant section before changing or reviewing sync behaviour.

## Data flow

```
User edit → Automerge doc change → two outbound paths:
  1. Incremental: VaultNetworkAdapter → WAL → SyncPoller → server push
  2. Snapshot:    markItemDirty → SnapshotManager/SnapshotPusher → server snapshot upload

Server → two inbound paths:
  1. Incremental: SyncPoller pull → SyncPullQueueManager → Automerge merge
  2. Full state:  ManifestSyncManager → ManifestDeltaCalculator → fetch snapshots → hydrate docs
```

The local Automerge doc in IndexedDB is always the complete, authoritative state. The WAL, snapshots and server rows are only delivery mechanisms. The server cannot decrypt anything, so it never merges or reconciles. It only relays data.

## Incremental sync (WAL)

- Outbound Automerge sync messages are appended to `SyncWriteAheadLog` (it has its own IndexedDB database). `SyncPoller` encrypts and pushes them via `pollSyncBatchWithToken`, and entries are removed once the server acknowledges them.
- **Pruning is safe.** When the WAL exceeds `MAX_ENTRIES`, `performPruneOldest` drops old entries. Nothing is lost, because the local doc is authoritative and the next snapshot captures the full merged state.
- **Torn compaction self-heals.** If the worker crashes mid-compaction, `readAll()` finds entries listed in another entry's `replaces` array and purges them.
- **In-flight safety.** `SyncPoller.executePoll` calls `wal.unmarkInFlight` in a `finally` block, so entries cannot get stuck in-flight.

### Poll result contract

`executePoll` returns `'success' | 'failure' | 'noop'`, which drives `SyncOrchestrator` backoff:
- `'success'` resets backoff. Return it only when the whole cycle had no errors.
- `'failure'` triggers exponential backoff. Return it whenever push or pull processing throws.
- `'noop'` leaves backoff unchanged, for example when there was nothing to do.

If `processPullResults` or any I/O throws and the poll still reports `'success'`, backoff resets while `hasImmediatePendingPulls()` stays true. The result is a 0ms re-poll loop.

### Pull filtering and cursors

- In `pollSync`, items present in `pullCursors` (targeted per-item pulls) are filtered out of `globalPullResult` (the account-wide pull) to prevent cursor jumps. If the global pull truncates an active item, that item's own `batchPullResult` reports `hasMore` with a `nextPageToken`, and the next poll continues from there.
- Cursors advance monotonically. `SyncPullQueueManager` sorts messages ascending and `break`s on a parse failure, so the cursor only reaches the last message that was processed successfully. It skips `cursor <= initialCursor`.
- **Server cursor format:** `relativeTimestampSeconds * 10_000_000 + random(0, 9_999_000)` (`automergeSyncService`). The `FlockSyncMessages` key is `syncId` (`${account}#${itemId}`) plus `cursor`, so a collision needs the same account, the same item, the same second and the same random offset (P ≈ 10⁻⁷).
- **No lookback window.** An earlier 10s overlap (`OVERLAP_CURSOR_DELTA`) plus a client LRU of seen cursors caused every client to re-download the same batch on every poll forever. Queries are now strictly `#c > :fromCursor`. In the rare race where a write with a lower random offset commits after a read in the same second, snapshots and manifest sync recover the missed change. Do not reintroduce a lookback.
- **Page tokens are opaque.** The driver issues `nextPageToken` / `globalNextPageToken` and checks them when they come back (`validatePageToken`); the Dynamo driver wraps its `LastEvaluatedKey`. The router validates every token before storing pushed messages, so a rejected poll never leaves pushed messages the client would push again. On `BAD_REQUEST` the client drops all its page tokens (`resetPagination`) and continues from its cursors. Pagination doesn't depend on the token: a client that drops it advances its cursor to the highest message received and continues with `cursor > from`.
- Failed pull messages are retried up to `MAX_PULL_RETRIES` (5, `PullRetryTracker`) before the item is quarantined.

## Snapshot sync

- `SnapshotManager` debounces dirty items (30s default, 5 min max wait) and uploads encrypted full Automerge binaries. Failures back off at 2s → 5s → 10s → 30s → 60s. After `MAX_CONSECUTIVE_SNAPSHOT_FAILURES` (5, `SnapshotPusher`), the item is dropped from the dirty queue.
- When offline, the orchestrator stops polling and `SnapshotManager` halts retries. On reconnect, backoff resets and a poll runs immediately.

### Monotonic versions (no clock-based reconciliation)

`putSnapshots` runs an atomic `version = if_not_exists(version, 0) + 1` and returns the new version. The client stores it as `baseVersion` in its `lastModified` record. `ManifestDeltaCalculator` then decides:

| Condition | Action |
|---|---|
| V_server > V_base | Fetch the snapshot and merge it into the local doc |
| V_server > V_base and server deleted | Apply the tombstone locally |
| V_server ≤ V_base and dirty | Push a snapshot |
| V_server ≤ V_base and clean | Do nothing |
| Item missing from the server manifest | It was created offline, so push a snapshot |

Physical timestamps (`localModifiedAt`, `serverTime`, `SKEW_BUFFER_MS`) remain only as a legacy fallback for records that have no version.

### Snapshot writes are intentionally LWW (no OCC)

`itemsRouter.putSnapshots` overwrites without a version condition. This is safe for four reasons:
- Snapshots are recovery baselines, and overwriting one never touches any client's local doc.
- Every edit is also kept for 90 days as incremental messages in `FlockSyncMessages`.
- Hydration merges rather than replaces (`existingHandle.merge(...)` / `Automerge.merge`). A stale snapshot cannot clobber newer edits, because merge(A+B, A) = A+B.
- When a client merges a stale snapshot, `hydrationResult.hasLocalChanges` is true, so it calls `markItemDirty` and re-uploads the merged state.

OCC would be harmful. A blind relay cannot resolve conflicts, so concurrent or offline flushes would churn on retries and eventually false-quarantine healthy items. OCC is reserved for centralized, non-CRDT state such as `keyringVersion` during key rotation.

## Deletion and IDs

- Deletes are soft-deletes. The CRDT doc gets `deleted: true`, and that propagates through messages and snapshots (`metadata.deleted`). `FlockItems` rows are never hard-deleted and have no TTL.
- A hard-delete would be undone. An item missing from the manifest looks like an offline creation, so manifest sync would re-upload it.
- Deletion is terminal, with no undelete. New items always get a fresh `generateItemId()` (126-bit nanoid). Reusing an ID would merge the old entity's history into the new one.
- `AutomergeDocStore.findOrCreateHandle` refuses to create a blank doc when `hasDataInStorage(itemId)`. This guard prevents data loss: without it, a handle-lookup timeout would overwrite an existing doc.
- Selectors filter `!item.deleted`, and `AutomergeIndexManager` excludes tombstones from the active index.

## Account settings document

Account settings the app syncs (`SyncDomain.syncedMetadataKeys`) live in an encrypted Automerge document managed by `AccountSettings`. Other metadata keys stay in the device's local index. The worker merges both and emits them as `metadataUpdated`, with the document's values winning.

- **Fixed ID.** The ID is `settingsDocId(account)` (`settings-${account}`), so every device agrees on it without coordinating. This is the one exception to "never recreate a doc under an existing ID": two devices can create it concurrently, for example while migrating. Their histories merge because each setting is a top-level key. Two devices that first create the same nested object concurrently keep only one of them, so prefer flat values.
- **Created lazily, never deleted.** The document is created on the first write of a synced key and never seeded with defaults, which would overwrite real values from other devices. `forceDeleteRecoveryItem` and `recreateOversizedItem` refuse it.
- **Writes are diffs.** The app sends whole objects, so `AccountSettings` skips unchanged keys and edits nested maps and lists in place. Replacing a map would discard a concurrent edit to another field.
- **An ordinary document otherwise.** It is in the item index, so the WAL, snapshots, manifest sync, key rotation and backups all handle it. The worker filters it out of the `indexUpdated` event sent to the app (`SyncWorkerContextConfig.onIndexUpdated` still sees it, so the worker subscribes to it) and routes its changes to `AccountSettings` instead of `itemUpdated`. `withSettingsDocPassthrough` keeps it away from the app's codec.
- **Legacy migration.** After each manifest sync, so that the server's copy has been hydrated first, `migrateLegacySettings` copies settings from the app's `LegacySettingsSource` and from local metadata into the keys the document lacks, clears the source and then strips the local keys. Keys already in the document win, because another device migrated them first. A failure leaves everything in place for the next sync. Failures are logged and never fail the manifest sync.

## Doc-bound ciphertexts

Snapshots and sync messages are encrypted with `vault-doc:<itemId>` as AES-GCM associated data and marked `format: 2` (`DOC_BOUND_FORMAT` in `packages/vault-shared/src/crypto.ts`). Without it, the server could serve item A's snapshot as item B's, and B's device would merge A's whole history into B, which cannot be undone.

- **Bind the ID the plaintext is applied to.** `snapshotBuilder` and `SyncPoller` encrypt with the item ID; `ManifestHydrator` and `SyncPullQueueManager` decrypt with the ID of the doc they apply the result to. Taking the ID from a separate field in the server's response would defeat the check.
- **The flag cannot be used to downgrade.** Stripping `format` from a bound ciphertext makes it decrypt without associated data, which fails. An unknown `format` is rejected.
- **Unbound ciphertexts still decrypt for now**, because older snapshots and messages are unbound. Until they are rejected, a malicious server can still serve unbound ciphertexts it kept. `SnapshotFormatUpgrade` rewrites every snapshot once per device after a manifest sync without failures (or one skipped because a clean sync ran within the day), when local docs include everything in the server's snapshots. It runs only in the leader tab and at most once per session, so a persistently failing item doesn't re-upload everything on every sync.
- **Every server path must keep `format`.** zod strips unknown keys and the Dynamo driver copies snapshot fields by name, so a field missed anywhere silently makes bound ciphertexts undecryptable.
- **Not bound:** the keyring, cross-tab BroadcastChannel messages and backup files. The server holds only one keyring per account and never sees the other two. Binding also does not stop the server replaying an older snapshot of the same item; hydration merges, so that only matters to a device that has never seen the newer state.

## Oversized items (ID rotation, never in-place compaction)

Snapshots are limited to 350 KB. A fresh `Automerge.init()` doc under the same `documentId` would have disjoint heads. Any peer or snapshot carrying the old history would then merge back in and resurrect it. So `ItemOperations.recreateOversizedItem` works like this:
1. It rejects the request if the item's current content (without history) is over 300 KB, because the user has to reduce it manually.
2. It creates and indexes a new doc under a new random ID with the latest content, then remaps group memberships from the old ID to the new one.
3. Only then does it soft-delete the old item. If any step fails it throws, which leaves the old item indexed and quarantined, so a retry is safe. Concurrent calls for the same ID are merged with a `KeyedSingleFlightGuard`. If the source item is already deleted, it finalises the previous recreation (index removal, unquarantine) and does not create another copy.

The deleted old doc still exceeds the limit. `SnapshotPusher` therefore uploads a payload-less tombstone (`toTombstoneSnapshot`: `deleted: true`, no `snapshot`) and does not quarantine it. The server sets `metadata.deleted`, bumps the version and keeps the last real snapshot. Hydration returns early on `metadata.deleted`, and no synced heads are recorded for tombstones.

## Manual recovery store

Items that can't be synced are quarantined in `manualRecoveryStore` and shown to the user.
- `kind` is one of `pullDecryption`, `snapshotDecryption`, `oversized`, `snapshotFailure`, `pushFailure` or `unknown`. For legacy entries it is inferred from the reason text.
- Only `pullDecryption` is auto-cleared, and only by a successfully parsed inbound message from another device. Own push echoes are excluded via `SyncPullQueueManager.recordOwnPushedMessage`.
- A server-confirmed snapshot upload clears every kind, as does any explicit user action (retry, overwrite, delete, recreate, dismiss).
- A weaker quarantine never overwrites an `oversized` entry. Oversized detection (`SnapshotTracker`, `DataRecoveryDialog`) checks `kind`, never reason text.

## Multi-tab and leader election

- `LeaderElection` uses `navigator.locks`. Only the leader runs the `SyncOrchestrator` poll loop. Followers keep a live Repo and sync with other tabs over `EncryptedBroadcastChannelNetworkAdapter`.
- Only tabs with `isLeader === true` send heartbeats on the presence channel. A leader that yields to a higher-priority `claim` calls `revokeLeadership(false)`, which keeps the presence channel and heartbeat timer so it can detect a crash of the new leader.
- `multipleLeadersDetected` must fire only when there are genuinely 2+ active leaders. A follower receiving the sole leader's heartbeat does not count.

### Missing key version on cross-tab messages (intentional inline wait)

When a message arrives with a `kver` that is not in the keyring, the receive queue `await`s `waitForKeyVersion(kver, timeout)` and fires `onKeyVersionMissing`. This is not a head-of-line blocking bug, for five reasons:
- It only happens during key rotation or a password change.
- The key normally arrives via `localStorage` / `VAULT_EVENTS_CHANNEL` within about 10–50ms.
- Waiting preserves causal ordering.
- The following messages from that tab need the same key anyway.
- After `keyWaitTimeoutMs` (5s), the message moves to `pendingKeyMessages`, `waitForKeyAndDrain` takes over in the background, and the queue resumes. No messages are dropped.

Cross-tab sync is an ephemeral optimisation. IndexedDB and the server remain the durable source of truth.

## Local storage layout

- Automerge docs: `VaultIndexedDBStorageAdapter`.
- WAL: its own IndexedDB database.
- Sync metadata: one database per account, `flock-sync-metadata-${accountId}` in Flock (store `sync-metadata`), opened once via `getSyncMetadataStorage(accountId)`. Its keys are `cursors`, `indexDoc`, `lastModified` (including `baseVersion`), `syncedHeads`, `snapshotsDocBound` and `deviceDataVersion`. The stores only read the current layout.
- Older layouts: the worker config's `migrateLocalData(accountId)` hook runs at the start of `SyncWorkerContext.initialize()`, before any store is read, under the `localDataMigrationLock` Web Lock so tabs take turns. A failure fails initialization, because starting would create an empty index that a later migration would keep over the old one. Flock's hook (`src/app/vault/legacy/localData.ts`) imports its per-store databases, the consolidated store's earlier keys and old value shapes, and deduplicates manual recovery entries (its own `manualRecoveryMigrated` key).
- All storage names come from `VaultStorageNames` (`packages/vault-client/src/sync/shared/storageNames.ts`). Renaming one orphans the data stored under the old name.
- Logout or reset: `clearAccountLocalData` → `clearSyncMetadataStorage` drops the whole metadata database. The store-level `.clear()` only clears its own key.

## Shutdown order (`ServiceLifecycleManager`)

- Shut down the Automerge Repo before clearing IndexedDB. Otherwise pending saves write data back into the cleared database.
- Don't run `clearSyncMetadataStorage` (`dropInstance`) concurrently with per-store `.clear()` calls on the same database.
- `wal.clear()` targets a different database, so it may run concurrently with the above.

## Event hub concurrency

`SyncEventHub.emit` is fire-and-forget. Async listeners are not awaited, and their rejections are caught and logged. This keeps producers such as Repo network events, WAL appends and pull processing from being slowed by listener I/O. Listeners must therefore handle concurrent in-flight invocations themselves, using `SingleFlightGuard`/`KeyedSingleFlightGuard`, `AsyncMutex`/`KeyedAsyncMutex`, `ItemLockCoordinator`, `AsyncQueue` or monotonic tick counters (for example `SnapshotTracker.dirtyItemsTick`).

## Server limits

- `pushSyncMessagesBatch` chunks writes into groups of 25, the `BatchWriteItem` limit.
- `fetchSnapshotsByIds` chunks reads into groups of 100, the `BatchGetItem` limit.
- `pullAutomergeSyncBatch` limits per-item queries to `DEFAULT_PULL_BATCH_CONCURRENCY` (10) via `mapWithConcurrency`.
- `UnprocessedItems` / `UnprocessedKeys` are retried with jittered exponential backoff.

## Other recovery

- Worker health (`syncWorkerHealth.ts`) sends a 15s ping and treats a 30s silence as a timeout. A crashed worker is auto-restarted up to `MAX_CONSECUTIVE_CRASHES` (3) times.
- `ManifestSyncManager` reconciles daily, and also every 7 days when forced.
