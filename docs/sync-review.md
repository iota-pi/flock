# Sync Review (2026-11-20)

An evaluation of the sync engine against [sync-design.md](sync-design.md), with proposed simplifications and improvements. Nothing here has been implemented.

Paths are shortened: `vc/` is `packages/vault-client/src/`, `vs/` is `packages/vault-server/src/` and `vsh/` is `packages/vault-shared/src/`. Each finding says whether it was **verified** in the code or is **inferred**.

## Summary

The engine is careful, and most of its parts are load-bearing. The poll schedule is a pure state machine, the outbox is marks over the doc rather than a WAL, and the snapshot phase shares the poll's backoff. Those are the right shapes. The best opportunities are:

1. **Rule S2 (snapshot rechecks) is redundant with S3.** S3 already heals the race S2 exists for, well inside the log's TTL. Dropping S2 removes a store, a hook on every pulled page, a plumbing path through the snapshot uploader, and a DynamoDB read on every `putSnapshots`.
2. **Two small durability and recovery gaps.** The log cursor can be saved before the docs it covers are, and a stale gap's request for a manifest sync is lost if that sync can't fetch the manifest.
3. **Server cost is dominated by things the client controls.** Every manifest sync reads every item in full, snapshots included, because projections don't reduce DynamoDB read cost. Snapshots are also re-uploaded within 1–5 minutes of every edit and on every page hide, though the log already carries the change for 30 days.
4. **Ordering that is defended rather than structural.** Manifest syncs run on their own timer, concurrently with polls. Per-item sync state is split across five classes with three save loops. Leadership claims bypass the Web Lock and are reconciled over a heartbeat channel.

There's no model-based test of the invariants (S1–S3, tombstones, ack/mark ordering), so build one before removing anything.

---

## 1. The system as it really is

### Moving parts

- **Worker components.** `SyncWorkerContext.createServices` builds 27 services (`vc/worker/SyncWorkerContext.ts:138-166`, `:227-593`), plus about ten built inside them: `IncomingChanges`, `SnapshotBuilder`, `SnapshotTracker`, `SnapshotPusher`, `ManifestHydrator`, `LeaderElection`, `EncryptedBroadcastChannelNetworkAdapter`, `LogCursorStore`, `LastSyncedStore` and `ItemSubscriptions`.
- **Main-thread components.** There are five: `SyncBridge`, `WorkerLifecycleManager`, `SyncWorkerHealthMonitor`, `SyncEventProcessor` and `SyncDOMListeners`.
- **Concurrency primitives.** The worker and client hold 26 instances of `SingleFlightGuard`, `AsyncMutex`, `AsyncQueue`, `AbortableRun` and lodash `debounce`, and make 47 `fireAndForget` calls (non-spec files under `vc/worker` and `vc/client`).
- **Server-bound delivery.** There are two payloads, log rows and snapshots, with four senders:
  - the poll's push (`ChangeOutbox.pushItems`);
  - the poll's snapshot phase (`SnapshotManager.pushDue`);
  - the manifest sync's own upload (`SnapshotManager.uploadNow`, `vc/worker/SnapshotManager.ts:108`);
  - rewrites (`ItemReencryptor` → `uploadSnapshotBatch`).
- **Device-bound delivery.** There are two payloads, log pages and snapshots, with four triggers for snapshot fetches:
  - manifest deltas;
  - `GapHealer`;
  - `FirstStart.runDue`;
  - recovery actions.

  The last three bypass the deltas through `ManifestSyncManager.fetchSnapshots` (`vc/worker/ManifestSyncManager.ts:145`).
- **Cross-tab delivery.** Each tab runs its own dedicated worker and Repo (`src/app/vault/syncBridge.ts:53`). They share:
  - the IndexedDB stores;
  - the encrypted Automerge `BroadcastChannel`;
  - two `RealtimeBus` channels (sync: `sync_ping`, `item_dirty`, `tab_visibility`; index: `indexUpdated`, `metadataUpdated`);
  - the leader presence channel;
  - the vault events channel for keys;
  - two Web Locks (leader and local data).

  That's five broadcast channels plus shared storage.
- **Recovery and healing paths.** I count 15:
  1. Parked entries and `GapHealer`.
  2. A stale gap leading to a manifest sync.
  3. Catch-up's manifest sync.
  4. S2 rechecks.
  5. S3 unconfirmed pulls and the upstream check.
  6. Hydration that finds local changes, which marks the item dirty and pending.
  7. The leader's `onDocChanged` recheck.
  8. The dirty-flag startup audit.
  9. The `snapshotOnly` fallback.
  10. Bisecting refused rows.
  11. Oversized items going to `recreateOversizedItem`.
  12. Version-gated quarantine.
  13. First start's targeted fetches and stuck counts.
  14. Missing local data sent to `GapHealer.requestSnapshot`.
  15. `StorageRecoveryService.retrySave` and the worker health restart.

### Local edit → log → other devices (verified)

1. **The edit.** An edit changes the doc and calls `markDocumentDirty` (`vc/worker/SyncWorkerContext.ts:399-404`), which does three things: it makes a snapshot due a minute later (`SnapshotTracker.markItemDirty`), writes a pending mark with a new tick to the `outbox` store, and publishes `item_dirty` to the other tabs. The mark's `onMarked` calls `orchestrator.flush()` (`:307-310`), and flushes made in the same turn share one 0 ms poll.
2. **A follower's edit.** It reaches the leader three ways: its persisted mark, the `item_dirty` message (`:627-635`), and the doc change over the Automerge broadcast adapter. The doc change ends up in `ChangeOutbox.onDocChanged` (`vc/worker/sync.worker.ts:324`, `vc/worker/ChangeOutbox.ts:221`), which marks anything it finds unpushed.
3. **The poll.** `SyncPoller.executePoll` (`vc/worker/SyncPoller.ts:54-94`) runs, in order: `firstStart.ensureSynced`, catch-up, `pushPending`, an empty exchange if nothing was pushed, a catch-up re-read, any manifest sync a lost row asked for, `healer.runDue`, `firstStart.runDue` and `snapshots.pushDue`.
4. **The push.** `pushItems` reads `getChangesSince(doc, serverHeads)` under the item lock (`vc/worker/docStore/AutomergeDocStore.ts:474-487`). It packs rows of at most 256 KB into requests of at most 99 rows or 3 MB. Each request is one `exchange` (`vc/worker/SyncPoller.ts:113-136`), serialised by a mutex. The acknowledgement is recorded first: server heads are set and saved, then the mark is cleared by tick compare-and-delete (`vc/worker/ChangeOutbox.ts:384-393`). Only then is the page that came back applied.
5. **The server.** `pollLog` appends the rows, then reads (`vs/services/syncLogService.ts:23-33`). An append reads the head row (consistent `GetItem`), then runs one `TransactWriteItems` that updates the head and puts each row (`vs/drivers/dynamo/syncLog.ts:116-147`). The read is a consistent `Query` of at most 200 rows (`:149-166`). Every protected call also reads the account record consistently (`vs/trpc/trpc.ts:130`).
6. **Another device.** `SyncLogPuller.process` (`vc/worker/SyncLogPuller.ts:159-202`) handles each entry in seq order. It checks contiguity (fresh or stale gap, `:213-232`), skips the device's own echoes, decrypts the row bound to its item, and calls `IncomingChanges.apply`. That applies the row under the item lock, and the server heads follow only if the doc matched them before (`vc/worker/IncomingChanges.ts:28-41`). On failure the entry is parked. The cursor advances and is saved after a 1 s debounce (`:71-74`). The device then publishes `sync_ping` to its tabs, records S3's unconfirmed pulls, and runs the S2 rechecks (`:199-201`).

### Snapshot path (verified)

`SnapshotTracker` makes an item due 1 min after its last edit, at most 5 min after its first, or sooner on request. The tracker brings the next poll forward through `onSnapshotDue`. The poll's last phase runs `SnapshotManager.pushDue`, behind a `SingleFlightGuard` shared with `uploadNow` (`vc/worker/SnapshotManager.ts:34,95-117`).

`SnapshotPusher` (`vc/worker/SnapshotPusher.ts:262-310`) pushes every dirty item to the log, then builds each snapshot. The build runs the S1 check in the same synchronous section as `Automerge.save` (`vc/worker/SnapshotBuilder.ts:117`). A deferred build is pushed and built again. The snapshots are batched by size and sent with `putSnapshots`.

On the server (`vs/services/snapshotService.ts:32-92`), each item is one `UpdateItem` that bumps the version, sets or removes `heads` and returns `ALL_OLD`. Then come one `ADD` to the account's `storageBytes` and one consistent read of the log head, for S2's `logSeq` (`:83`). Back on the client, `recordStoredSnapshots` clears the dirty tick, raises the base version, and fans out to `confirmSnapshotOnly`, `firstStart.onSnapshotConfirmed` and S2's `onSnapshotStored` (`vc/worker/SyncWorkerContext.ts:386-390`).

Snapshots are also flushed on every page hide (`vc/client/SyncBridge.ts:118-120` → `flushPendingSnapshots`), and before every manifest sync (`vc/worker/ManifestSyncManager.ts:277-278`).

### Manifest sync (verified)

**Triggers:**
- the leader starting or being promoted (`vc/worker/SyncOrchestrator.ts:270-274`);
- an hourly `setInterval` (`:374`);
- `onForeground` (`:307-310`);
- `bootstrapItems`;
- `fullResync`;
- three triggers inside a poll: catch-up, a lost row and `FirstStart.runDue`.

Outside a poll, these run with `fireAndForget`, concurrently with polls.

**Steps** (`vc/worker/ManifestSyncManager.ts:261-346`):
1. Gate on `manifestSyncMinGap`.
2. Upload due snapshots.
3. Fetch the manifest.
4. For candidates whose doc already holds the snapshot's heads, raise the base version and apply S3 (`findSnapshotsCoveredLocally`, `:388-435`).
5. Compute the deltas.
6. Mark the upstream items.
7. Hydrate the snapshots in batches of 50, honouring `deferred`.
8. Tell first start and the healer.
9. Migrate legacy settings.
10. Record the time and the device level.

On the server, `fetchManifest` is a `Query` of the whole account partition with a projection (`vs/drivers/dynamo/itemRecords.ts:163-190`). It isn't a consistent read.

### First start (verified)

First start runs only in the migration app. The main app passes `firstStartDataVersion: 4` with `minDataVersion: 4` (`src/app/vault/vault.worker.ts:16,23`), so it gets `FINISHED_FIRST_START` (`vc/worker/FirstStart.ts:508-523`, `vc/worker/SyncWorkerContext.ts:279`). Its hooks still run through the engine at ten points:

- `ChangeOutbox.isAwaitingFirstStart` and `canPush`;
- `SnapshotCoverage.firstStartState`;
- `BuildSnapshotResult.awaitingHeads`;
- `SnapshotPusher`'s skip;
- `SyncPoller.ensureSynced` and `runDue`;
- `ItemReencryptor`'s `waitingForSync`;
- `stuckItems`;
- the diagnostics.

### Cross-tab and leadership (verified)

The leader holds a Web Lock (`vc/worker/utils/LeaderElection.ts:325-356`). `claimLeadership` doesn't take the lock (`:124-149`). It grants "fallback" leadership at once and posts `claim` on the presence channel, and the lock holder yields but keeps the lock (`:203-209`). It takes leadership back when the claimer releases or times out (`:240-275`).

When the presence channel sees more than one leader, the engine pauses the Automerge `BroadcastChannel` sync (`vc/worker/SyncWorkerContext.ts:523-531`). Followers never poll. They see the leader's results through shared IndexedDB, `sync_ping` and the Automerge adapter.

### Divergences from the docs

- **`docs/local-encryption.md:20-21` is out of date (verified).** It lists "Cursors, heads, versions" under the sync metadata's plaintext keys. Since level 4, heads and base versions live in the sync log database's `items` store (`vc/worker/stores/itemSyncRecords.ts:10-18`, `vc/worker/stores/SyncLogDatabase.ts:8-16`). The sync log database row omits those item records and the dirty flag. See finding 12.
- **`sync-design.md:7-15` (the data-flow diagram) is incomplete (verified).** It shows one full-state inbound path, through `calculateSyncDeltas`. Three triggers bypass the deltas: `GapHealer`, `FirstStart.runDue` and recovery. The diagram also doesn't say that manifest syncs run on their own timer, concurrently with polls.
- **`sync-design.md:59` says a stale gap "asks for a manifest sync now" (verified).** It does, once. The request is consumed before the sync runs, and it's dropped if the sync can't fetch the manifest. See finding 3.
- **Overstated comment in `vc/worker/ChangeOutbox.ts:383` (verified).** It says "Heads are saved before marks clear", but `ServerHeads.save` swallows a failure (`vc/worker/ServerHeads.ts:63-79`), so marks clear anyway. That's safe: the heads stay unsaved in memory and are retried, and stale heads only resend. But the comment overstates the ordering.

---

## 2. Opportunities, ranked by value and risk

### 1. Drop rule S2 (snapshot rechecks): S3 already heals the race

**What.** Remove:
- `SnapshotCoverage.onSnapshotStored`, `onCursorAdvanced`, the `rechecks` map and its load (`vc/worker/SnapshotCoverage.ts:60-69,90-112`);
- the puller's call to them (`vc/worker/SyncLogPuller.ts:201`);
- the `logSeq` plumbing through `StoredSnapshotDetails`, `recordStoredSnapshots` and `uploadSnapshotBatch` (`vc/worker/snapshotUpload.ts:55`, `vc/worker/SnapshotPusher.ts:221-234`);
- `getLatestCursor` and `snapshotCursor` (`vc/worker/SnapshotPusher.ts:34,87`).

Later, also remove the server's `readLogHead` in `persistSnapshots` (`vs/services/snapshotService.ts:83`).

**Why.**
- **What S2 protects.** S2 makes the device whose upload replaced another device's snapshot re-upload once its cursor reaches `logSeq`.
- **S3 covers the same race:**
  - **The replaced author.** It sees V_server > V_base at its next manifest sync. Either its doc holds the winner's heads plus more, so it uploads (`vc/worker/ManifestSyncManager.ts:425-430`), or it lacks them, so it fetches, merges, finds local changes and uploads (`vc/worker/ManifestHydrator.ts:363-366`).
  - **Every device that pulled the replaced change.** Each holds an unconfirmed pull, and uploads after `pulledChangesGrace` (1 day) unless a snapshot confirms it.
  - **Existing evidence.** The integration suite already shows S3 healing this race alone: "heals the same race from the manifest check alone (S3)" (`vc/worker/syncLog.integration.spec.ts:202`).
- **Only latency changes.** Without S2, the server's snapshot can lack a change for up to about an hour (the author's next manifest sync), or a day (the grace) if the author never returns.
- **Who could notice.** Only a device that hydrates from a snapshot without reading the log covering that change. Fresh and long-away devices read the whole retained log after catch-up's manifest sync, and the log keeps rows for 30 days. `GapHealer` fetches are backed by log rows.

  The one visible case is `replaceFromServer` run during the window. It converges at that device's next manifest sync, instead of within seconds.
- **S2 doesn't cover `snapshotOnly` changes either.** A change too large for a row is never in the log, so S2 compares equal heads and does nothing. S3 is what catches it.

**What it removes.** One IndexedDB store's traffic, an `await` on every pulled page (reading each due item's heads), a fan-out branch in `onSnapshotStored`, and one consistent DynamoDB read per `putSnapshots`. It also simplifies `sync-design.md`'s "Why a stale snapshot can't stay stale" to a single rule.

**Risk.** None of the ten rules is touched. Rule 8 stays as it is: versions are still compared, and S2 only adds a cursor compare. It doesn't challenge the intentional LWW design, which already relies on S3 as its backstop (`sync-design.md:179-181`). Two specs change: "catches up a snapshot that replaced another device's (S2)" (`:188`) and "rechecks a rewrite that jumped a version" (`:899`). Rewrite them to assert the heal at the next manifest sync.

**Migration.**
- **Client storage.** No format change. Leave the `snapshot-rechecks` store in place: names must never change, and an unused store costs nothing. Clear its rows once, or not at all.
- **Server.** Keep returning `logSeq` for one release, since older clients read it, then drop the head read.
- **Data levels.** No `MIN_DATA_VERSION` bump.

**Effort:** S–M. **Confidence:** verified in code and tests. The latency bound is inferred from `SYNC_TIMEOUTS`.

### 2. Flush pulled docs before the cursor moves past them

**What.** In `SyncLogPuller`, save the cursor only after `repo.flush(appliedDocIds)` resolves. `Repo.flush(documents?)` exists in the pinned automerge-repo (`node_modules/@automerge/automerge-repo/src/Repo.ts:658`). The same applies to the debounced save (`vc/worker/SyncLogPuller.ts:71-74`) and the shutdown save (`:106-114`).

**Why.**
- **Today there's no ordering.** The cursor goes to the sync metadata database after a 1 s debounce. The doc goes to the sealed Automerge database on the Repo's own throttle. Nothing orders the two.
- **The failure.** If a doc save fails (quota) or the tab dies first, the device has moved past a change it never stored. It recovers only through manifest sync, when some snapshot newer than its base version holds the change.
- **The narrow loss.** The author pushed and died before uploading, and this was the only other device. Its S3 record (written at `:199`, in a third database) may survive while the doc doesn't, so it can never upload what it lacks.

The fix makes rule 1 ("the doc is the source of truth, the log only delivers it") structural for pulls, as it already is for pushes: marks clear only after the server acknowledges.

**Risk.** It strengthens rule 1 and touches no other rule. Flushing adds latency to the cursor save, which is already debounced.

**Migration:** none. **Effort:** S. **Confidence:** the missing ordering is verified. The failure needs a crash or quota failure inside a ~1 s window, so it's rare.

### 3. Keep the puller's recovery requests until they're met, and make its state explicit

**What.**
- **The dropped request.** `SyncPoller` consumes `takeManifestSyncRequest()` before running the sync, then ignores whether it fetched the manifest (`vc/worker/SyncPoller.ts:73-75`, `vc/worker/SyncLogPuller.ts:141-145`). `ManifestSyncManager` returns `null` without throwing on a fetch failure when the device has items (`vc/worker/ManifestSyncManager.ts:175-187`). So a lost row's recovery sync can vanish, and the poll still reports `'success'`.

  Make it behave like catch-up, which throws when the manifest wasn't fetched (`vc/worker/SyncPoller.ts:102-107`): keep the request until a sync fetches the manifest, and fail the poll otherwise.
- **The scattered state.** Fold the puller's `gap`, `isCatchingUp`, `hasCaughtUpManifest`, `manifestSyncDue` and `hasMore` (`vc/worker/SyncLogPuller.ts:59-66`), and the poller's `isCatchUpDue` (`vc/worker/SyncPoller.ts:41`), into one state value with named transitions. That's the way `pollSchedule.ts` did it for the schedule.

**Why.** It closes a hole in the spirit of rule 4: a recovery step's I/O failed and the poll reported success. After a failure, recovery falls back to the hourly sync. Six flags spread over two classes become one state, and it can be tested as a table, like `transitionPoll` (`vc/worker/pollSchedule.ts:253`).

**Risk.** It strengthens rule 4. A failed recovery sync now backs off. It can't loop at 0 ms, because a failure never schedules at 0 ms.

**Migration:** none. **Effort:** S for the fix, M with the state refactor. **Confidence:** verified.

### 4. Add a model-based convergence test before removing anything

**What.** Add a seeded random scenario runner on the existing `FakeVaultServer` and `syncLogHarness` (`vc/worker/__test__/`), with a small in-repo PRNG, so there's no new dependency.

**Operations** for each of N devices: edit, delete, go offline, reload, crash before a save, let the clock pass `snapshotDebounce`, `pulledChangesGrace` or the TTL, drop a log row, and race two snapshot uploads.

**Assertions** after quiescing:
- every live doc has identical heads;
- no deleted item is live anywhere;
- every change on any device is in the server's snapshot or an unexpired row;
- nothing is quarantined.

**Why.** S1–S3, tombstone finality and the ack/mark ordering are argued in prose and pinned scenario by scenario. A model test is what makes findings 1, 5, 9 and 11 safe to land. It would also have caught findings 2 and 3, which need a crash or a failed fetch at a particular step.

**Risk:** none. **Migration:** none. **Effort:** M. **Confidence:** the gap is verified: there's no property or fuzz testing in `packages/`.

### 5. Upload snapshots lazily, and stop uploading on every page hide

**What.**
- **Cadence.** Raise `snapshotDebounce` (1 min) and `snapshotMaxWait` (5 min) in `vc/shared/syncConfig.ts:66-68`, to something like 15–30 min and 1–2 h, still well under `pulledChangesGrace` (1 day).
- **Page hide.** Change `onVisibilityHidden` (`vc/client/SyncBridge.ts:118-120`) to save the dirty flags (`tracker.flushPendingSave`) and flush the log push, without uploading snapshots.
- **Keep:**
  - the explicit flushes for removing an account, exporting a backup and recovery actions (`vc/worker/SyncWorkerContext.ts:972-984`);
  - the zero-delay requests (`requestSnapshot`) for `snapshotOnly` and refused items.

**Why.**
- **Snapshots are the most expensive write.** Each upload rewrites the whole item, so it costs about one WCU per KB. A log row costs only its own size, inside one transaction with the head row. A 50 KB item edited once costs roughly 8 WCU in the log and 50 WCU or more for its snapshot. Today that repeats every 5 minutes of continuous editing, and on every hide, which a mobile PWA does constantly. Each upload is also another Lambda call, and another version bump that makes every other device's next manifest sync decrypt heads and check that item.
- **The log already delivers the change** for 30 days, and S3 guarantees some device uploads it within a day.

**Risk.**
- **S1** is unchanged.
- **S3** needs the cadence to stay well under the grace. Otherwise pulling devices upload duplicates, which is harmless but wasteful.
- **The sync indicator** is unchanged: it counts only pending marks (`sync-design.md:139`).
- **`getUnsyncedChanges`** counts more dirty items, but it flushes them first.
- **Oversized detection** comes later.
- **A device that hydrates after the TTL** is the only reader that depends on snapshot freshness, and 30 days is far beyond any cadence suggested here.

This is a cost trade, not a simplification.

**Migration:** config only. **Effort:** S. **Confidence:** the mechanism is verified. The cost figures are inferred from DynamoDB's billing model, not measured. Measure WCU per day per account before and after.

### 6. Serve the manifest from a projection-only index

**What.** Add a global secondary index on `FlockItems` (partition `account`, sort `item`), with an `INCLUDE` projection of `version`, `modifiedAt`, `metadata`, `deleted` and `heads`. Make `fetchManifest` query it (`vs/drivers/dynamo/itemRecords.ts:163-170`). Add it in `vs/drivers/dynamo/tables.ts`, in the SST table definition, in `yarn initdb`, and in `vitest.dynamodb.ts`.

**Why.** A `Query` consumes read capacity for the whole item read, whatever its projection. Today every manifest sync reads every snapshot in the account, up to 350 KB each:
- **When it runs:** on every leader's startup and promotion, on foreground after the min gap, and hourly.
- **What it costs:** a 500-item account averaging 20 KB is about 10 MB, so about 1,250 RCU eventually consistent and at least ten 1 MB pages, to return perhaps 100 KB of manifest.
- **What the index costs:** an extra write of roughly 1 WCU per item write, which is small next to the snapshot write itself.

**Risk.** An index is eventually consistent, but the base-table query is already not a consistent read, so nothing weakens. Index lag could leave an item out of the manifest just after `uploadNow`. That item would be uploaded again, an extra write. It wouldn't be resurrected: rule 3 is about hard-deletes, and a missing deleted item re-uploads a tombstone. Rules 8 and 9 are untouched, and `heads` keeps its `format`, because the index projects the attribute whole.

**Migration.** Server and infra only. DynamoDB backfills a new index itself. There's no client change, no data-level bump and no wire change.

**Effort:** M. **Confidence:** the full-partition query is verified. The billing behaviour is inferred from DynamoDB's documentation, so check it in CloudWatch.

### 7. Fill each push to the transaction limit, not five items

**What.** `pushItems` prepares and sends five items at a time (`vc/worker/ChangeOutbox.ts:256`, `pollChunk: 5` at `vc/shared/syncConfig.ts:105`). Prepare items until the request is full instead: 99 rows or 3 MB, which `packRequests` already enforces. Keep `sendSettingAsideRefused`'s bisection over the items in the request (`:273-289`).

**Why.** Each exchange is one Lambda call, a consistent account read, a consistent head read, a transaction and a log `Query`. Pushing 200 pending items (a restore, a reconnect after offline edits, an import or `markRestored`) takes 40 exchanges today and about 2–3 after.

**Risk.** Rule 4 and S1 are unchanged. Memory is bounded by the 3 MB request. An abort lands between requests rather than between groups of five.

**Migration:** none. **Effort:** S. **Confidence:** verified.

### 8. Run the manifest sync as a phase of the poll

**What.** Remove the orchestrator's `setInterval` and its fire-and-forget triggers (`vc/worker/SyncOrchestrator.ts:270-274,307-310,369-396`). Add a `manifestDue` time to `pollSchedule`, the way snapshots have `snapshotDue`, and have `executePoll` run `ManifestSyncManager.sync` between the pull and the snapshot phase. `bootstrapItems` and `fullResync` become `pollNow` with the manifest forced.

**Why.** This is the same move that made snapshot uploads a poll phase (`sync-design.md:134`):
- one outbound loop;
- one abort, where `stopSyncing` aborts the manifest separately today (`:277-281`);
- one backoff per outage.

It removes these from what has to be reasoned about:
- the `uploadNow` versus `pushDue` guard (`vc/worker/SnapshotManager.ts:34,108-117`);
- `syncNow`'s "wait rather than share" rule (`vc/worker/ManifestSyncManager.ts:135-142`);
- a manifest hydration interleaving with a poll's push on the same item, which is safe today only through item locks and the "duplicates are harmless" argument.

**Risk.** A long hydration delays that poll's push. The catch-up path already accepts that. Rule 4 gets stricter, because a manifest fetch that fails now fails the poll. Item-level hydration failures still don't throw. Rules 5–7 are untouched.

**Migration:** none. **Effort:** M. **Confidence:** the concurrency is verified. The benefit is inferred.

### 9. One model of what the device knows about each item's server copy

**What.** Today one item's sync state is spread over five classes and four stores:
- server heads in `ServerHeads` (`vc/worker/ServerHeads.ts`);
- the base version and dirty set in `SnapshotTracker` (`vc/worker/SnapshotTracker.ts:38-40`);
- the `snapshotOnly` set, in memory only, in `ChangeOutbox` (`vc/worker/ChangeOutbox.ts:154`);
- unconfirmed pulls in `SnapshotCoverage`, in their own store;
- first start's records.

Replace the first four with an `ItemSyncState` that owns the `items` record and has one load and one debounced save. Split `SnapshotTracker` into that state and a small upload scheduler that keeps the due times and ticks. Pending marks stay separate, because they're a multi-writer compare-and-delete store, and so do parked entries.

**Why.**
- **The `items` store is read twice on every promotion,** by different paths: `puller.onLoad` → `serverHeads.load` (`vc/worker/SyncWorkerContext.ts:359-361`), and `onLeaderChange` → `tracker.load` (`vc/worker/SnapshotManager.ts:82-89`), as well as at start (`vc/worker/SyncWorkerContext.ts:676`).
- **Two save loops write the same records,** each preserving the other's fields (`ServerHeads.ts:63-79`, `SnapshotTracker.ts:246-271`).
- **`snapshotOnly` is lost on every reload,** so each session rediscovers it with a failed push.

One owner makes "what this device believes the server has" a single thing to reason about and test.

**Risk.**
- **Rule 8:** keep the max-merge of the base version.
- **"Only the leader clears dirty",** and "a save writes only the items this tab changed", both have to survive. They're the reason saves are per-field today.

**Migration.** No format change if the new fields (`snapshotOnly`, the time of an unconfirmed pull) are optional on `ItemSyncRecord`. Read the old `unconfirmed-pulls` store for one release, and keep its name. No `MIN_DATA_VERSION` bump.

**Effort:** M–L. **Confidence:** the duplication is verified. The benefit is inferred.

### 10. Leadership by lock steal, following the visible tab

**What.** Make `claimLeadership` call `navigator.locks.request(name, { steal: true }, …)`, and treat a stolen lock (an `AbortError` from the holder's request) as revocation followed by a fresh queued request. Today an `AbortError` is ignored at `vc/worker/utils/LeaderElection.ts:359`, and that has to change. Then delete:
- the presence heartbeats;
- the `isFallback` and `isYielded` flags, `otherLeaders` and multi-leader detection (`:38-53,198-276`);
- the pause of broadcast sync while two tabs lead (`vc/worker/SyncWorkerContext.ts:523-531`).

Add a policy: a follower the user returns to (`setVisibility(true, true)`) steals leadership while the leader's tab is hidden.

**Why.** Six flags make up an implicit state machine, and a leader that holds no lock can exist for as long as a claimer lives. The visible-tab policy also fixes a documented limitation, "A frozen leader keeps the lock" (`sync-design.md:259`). Today a frozen background leader stops every other tab from talking to the server until it thaws.

**Risk.**
- **The overlap window.** Between the steal and the old tab handling its rejection, two tabs may act as leader. That's the same window today's claim has. Pushes are idempotent, snapshots merge, and server heads are saved per item.
- **Mixed builds.** During a service worker update, an old-build tab ignores a stolen lock (the `AbortError` branch above) and would keep leading. Keep sending `claim` on the presence channel for a release, so old tabs yield.
- **Thrashing.** Rate-limit steals.

No rule of the ten is touched, but this is the single-writer design point, so it needs finding 4's test.

**Migration.** No names change. The presence channel simply goes unused after the transition release.

**Effort:** M. **Confidence:** the current behaviour is verified. The `steal` semantics come from the Web Locks spec and need a spike in the target browsers, Safari especially.

### 11. Retire first start from the engine

**What.** Delete `FirstStart.ts` and its ten hook points (see section 1). In the migration app, replace first start with a reset, which is `runFirstStartLocalPart` without the records: clear the server heads and cursor, and mark every item pending. The normal engine then does what it does for a new device: catch-up's manifest sync merges the server's snapshots first (`sync-design.md:106`), the push sends whole histories (duplicates are no-ops for receivers), and S1 defers each snapshot until its push lands.

**Why.** It removes about 520 lines and ten branch points from code the main app runs on every poll, although the main app always takes the `FINISHED_FIRST_START` path. `sync-design.md:130` already plans to remove it once level 4 is retired. This gives a retirement path that doesn't need device levels to be scanned, which isn't possible (`vault-extraction.md`, "Retiring a level").

**Risk.**
- **Cost.** `awaitingHeads` exists to avoid pushing whole histories. Without it, a large straggler account pushes about its whole size to the log, limited to 64 MB a day (`vs/quotas.ts:24-28`), with 429 backoff in between.
- **Snapshot upload.** The upload that `awaitingHeads` guards ("an upload can't replace a snapshot the doc lacks") is ordered behind the catch-up merge and S1, and S3 covers the rest.
- **Rules.** Rules 1 and 2 are untouched. Rule 10 holds, because nothing local is reset.

**Migration.** Migration-app work only. The device gate stays at 4. The `first-start` store and the `firstStartReset`, `firstStartSynced` and `walCleared` keys stay, unused, because names never change.

**Effort:** M. **Confidence:** the main app's bypass is verified. That the reset is equivalent is inferred, so prove it with finding 4's test, including the two "carries both sides across" cases (`vc/worker/syncLog.integration.spec.ts:789,819`).

### 12. Bring the docs back in line with the code

**What.**
- **`docs/local-encryption.md:20-21`.** Move heads, base versions and the dirty flag to the sync log database row.
- **`sync-design.md:7-15`.** Add the targeted snapshot fetches, and say whether the manifest sync runs inside the poll. Finding 8 would make that a single answer.
- **`sync-design.md:59`.** Describe the request semantics, after finding 3.
- **`vc/worker/ChangeOutbox.ts:383`.** Reword the comment.

**Why.** It's required by the brief, and the local-encryption table is what a security reviewer reads.

**Effort:** S. **Confidence:** verified.

### 13. Smaller hazards and dead code

**`RecoveryManager.quarantine` drops a concurrent quarantine of the same item** (`vc/worker/RecoveryManager.ts:109-111`). It returns silently while another quarantine for that item is in flight. A second kind arriving at that moment is lost until the next time it's reported: for example `snapshotDecryption`, which the context reports fire-and-forget from the hydrator (`vc/worker/SyncWorkerContext.ts:482-487`), racing a `missingChanges` quarantine from the healer. Queue it, or merge the kinds, instead.

**`GapHealer.runDue` reads the whole `parked` store again** for every due item (`vc/worker/GapHealer.ts:154,208-211`). That's O(items × parked rows). Group the one read by item.

**`BuiltSnapshot.snapshotCursor` and `modified` are sent but stripped** (`vc/worker/snapshotUpload.ts:3-9`), because zod drops them: `VaultSnapshotSchema` (`vsh/api.ts`) doesn't declare them. Client and server ship from one build, so only a client newer than its server, during a deploy, could meet a server that needs them. Remove them with finding 1.

**`sync.pollSync` stub** (`vs/trpc/routers/sync.ts:14-17`). Check the Lambda logs for its traffic and remove it when there's none, as `sync-design.md:29` plans.

**`ChangeOutbox.fillInCreatedAt`** (`vc/worker/ChangeOutbox.ts:292-304`) fills in marks from builds before `createdAt` existed. Every device in the main app is at level 4 or above, and first start wrote dated marks (`createPendingMark`). It's probably dead code. Inferred: check whether an old-build tab can still write an undated mark.

---

## 3. Things that should stay

I considered simplifying each of these and concluded it's load-bearing.

- **The contiguous log with a conditional head row** (`vs/drivers/dynamo/syncLog.ts:77-113`). Contiguity is what lets "fresh gap → wait" be correct without a lookback. A GSI or a timestamp ordering would reintroduce the lookback the intentional designs rule out.
- **Marks over the doc instead of a WAL** (`vc/worker/ChangeOutbox.ts:145-151`). Nothing can be lost in flight, and a false mark costs only an empty check.
- **Per-item marks with tick compare-and-delete in raw IndexedDB** (`vc/worker/stores/SyncLogDatabase.ts:153-162`). Followers write marks, so this is the multi-writer piece that finding 9 deliberately leaves alone.
- **Parked entries and `GapHealer`.** Contiguity alone doesn't remove missing dependencies: `snapshotOnly` changes, refused rows and catch-up past the TTL all produce rows whose dependencies only a snapshot carries. Parking also keeps the ciphertext across reloads, which Automerge's in-memory queue doesn't.
- **The manifest heads check** (`findSnapshotsCoveredLocally`). Base versions advance only on snapshot traffic, so without it every item edited elsewhere would be fetched again at every manifest sync.
- **S1 as a synchronous check beside `Automerge.save`** (`vc/worker/SnapshotBuilder.ts:117`). It's the premise S3 rests on.
- **S3's unconfirmed pulls.** After finding 1, this is the only backstop for an author that never returns.
- **The pure poll schedule** (`vc/worker/pollSchedule.ts`). It's the right shape, and finding 3 copies it.
- **Reading the whole retained log on catch-up.** I considered starting a fresh device's cursor at the log head read before its manifest fetch. That's unsafe: a change can be only in the log, because its author pushed and then died before uploading. Only a device that pulls it can upload it under S3.
- **Leader-only server access.** One writer of sync records is what keeps `ServerHeads` and `SnapshotTracker` simple. Finding 10 changes how a leader is chosen, not this.
- **A dedicated worker per tab, rather than one `SharedWorker`.** A `SharedWorker` would replace leader election and most of the cross-tab channels. But I couldn't confirm it's available on every platform this PWA targets, so a fallback would keep the current machinery anyway. Inferred.
- **Polling rather than server push.** At one user's scale, an idle visible tab costs one small Lambda call every 30 s. A WebSocket or SSE poke needs API Gateway connection state, which is more infrastructure than the latency it saves (see "Scope limits" in vault-extraction.md).

### Challenging an intentional design

I don't have a strong, specific argument against any of the "Intentional designs" in AGENTS.md. LWW snapshots stay safe after findings 1 and 5, because S1 and S3, not S2 or upload frequency, are what make them safe.

---

## 4. Test gaps

| Invariant | What pins it today | Gap |
|---|---|---|
| Convergence across devices under random interleavings | Scenario tests in `syncLog.integration.spec.ts` | No model-based test (finding 4) |
| Pulled changes are stored before the cursor passes them | None | Crash between the cursor save and the doc save (finding 2) |
| A lost row's manifest request survives a failed fetch | None | Finding 3 |
| One writer of sync records across a leadership handover | `LeaderElection` unit specs, `ItemRecoveryService.spec.ts:73` | No integration test of a claim while the old leader's exchange is in flight |
| A tombstone is never resurrected by the log, the manifest or a late snapshot | `calculateSyncDeltas` unit specs, one integration test (`:258`) | No multi-device test that mixes a late snapshot with a pulled delete |
| Manifest read cost | None | No assertion on what `fetchManifest` reads (finding 6) |

---

## 5. Suggested sequence

1. **PR "Pull durability and recovery requests".** Covers findings 2, 3 (the fix only) and 7.
   - The puller awaits `repo.flush` before saving the cursor.
   - The lost-row request persists until a sync fetches the manifest, and fails the poll otherwise.
   - Pushes fill to the transaction limit.
   - New tests: a crash between the doc save and the cursor save (simulate with a storage adapter that drops writes), a failed recovery manifest, and 200 pending items taking at most three exchanges.
   - No format changes. Low risk, and it gives the most correctness per line.
2. **PR "Model-based sync test".** Finding 4, plus the doc fixes in finding 12. Only tests and docs. Run it in CI with a fixed seed set, and nightly with random seeds if CI time allows.
3. **PR "Drop S2".** Finding 1, plus `snapshotCursor` and `modified` from finding 13.
   - Rewrite the two S2 specs to assert the heal at the next manifest sync.
   - The model test from step 2 must pass with S2 gone.
   - Update `sync-design.md`'s snapshot coverage section and its race argument.
   - Leave the store in place. The server keeps `logSeq` for a release, and a follow-up PR removes `readLogHead`.
4. **PR "Snapshot cadence".** Finding 5. Config, plus the hide handler. Record WCU per account per day in CloudWatch before and after, and add a test that a hide uploads no snapshot but saves the flags.
5. **PR "Manifest index".** Finding 6. Server and infra only, independent of the rest, so it can go first if cost matters most. Includes the table definition, `initdb`, the vitest table setup and a driver test that `fetchManifest` uses the index.

After these, findings 8, 9 and 10 are the structural work, each a PR of its own, with finding 4's test as the safety net. Do finding 8 before 9, because it removes one of the paths that reloads state on promotion. Finding 11 waits until the migration app's level 4 traffic is low enough that the reset approach's log volume doesn't matter.
