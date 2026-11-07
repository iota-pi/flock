# Sync Design Notes

Background and rationale for the sync system (`packages/vault-client/src/{worker,client,shared,utils}/`, `packages/vault-server/src/services/`). [AGENTS.md](../AGENTS.md) lists the rules. This file explains why they exist. Read the relevant section before changing or reviewing sync behaviour.

## Data flow

```
User edit → Automerge doc change → pending mark and dirty mark → two outbound paths:
  1. Incremental: ChangeOutbox → getChangesSince(doc, serverHeads) → SyncPoller → log append
  2. Snapshot:    SnapshotManager/SnapshotPusher → push to the log first → server snapshot upload

Server → two inbound paths:
  1. Incremental: SyncPoller → SyncLogPuller → loadIncremental into the doc
  2. Full state:  ManifestSyncManager → calculateSyncDeltas → fetch snapshots → hydrate docs
```

The local Automerge doc in IndexedDB is always the complete, authoritative state. The log, snapshots and server rows are only delivery mechanisms. The server cannot decrypt anything, so it never merges or reconciles. It only relays data.

## Sync log

Each account has one strictly ordered log, the `FlockSyncLog` table, keyed by `account` and `seq`. `sync.pollLog` pushes messages and reads the log in one mutation.

### Server

- **Rows are contiguous.** Every committed push uses exactly the next seqs, and a failed push uses none. One `TransactWriteItems` updates the head row (`seq: 0`, with the condition `head = :expected`) and puts each message, so a transaction for seqs `e+1…` can commit only after the one for `…e`. The head row isn't on the `FlockAccounts` record, because `extendSession` writes that on every request, and a write to an item in a running transaction fails.
- **Reads are consistent `Query`s on the base table,** strictly `seq > after`, with no GSI, page token or lookback. DynamoDB documents `Query` as read-committed, which may show some rows of a multi-row transaction and not others. Contiguity makes that harmless, because the client never moves past a missing seq it might still see.
- **A row's `encryptedMessage` is a run of Automerge change chunks** encrypted with the item's ID. There's only one kind of row, and an item's change set can span several rows, in dependency order.
- **Rows expire after `SYNC_LOG_TTL_DAYS` (30).** Snapshots are the lasting copy (see "Snapshot coverage").
- **`sync.pollSync` is a stub** that answers `CLIENT_OUTDATED`, for builds from before the log. A removed procedure would answer `NOT_FOUND`, which they treat as a failed poll, so they would never update. It can go once its traffic stops.

### Outbound: from the doc

There's no write-ahead log and no sync protocol against a pretend peer. The doc is the only copy of a change, so nothing can be pruned, compacted or stuck in flight.

- **Server heads** (`ServerHeads`, stored by `SyncedHeadsStore`) are heads whose every ancestor is on the server, in the log or in the item's current snapshot. They must be heads the doc has: `getChangesSince` returns the whole history, without throwing, for heads it lacks.
- **A pending mark** (`ChangeOutbox`) says an item may have changes after its server heads. It's a hint, and a false one costs an empty check. Each item has its own record, `{ itemId, tick }`, in the sync log database, so tabs never race on a shared value, and followers write marks too, so an edit survives a leader that crashes before pushing. A mark clears only if its tick is still the one the push read, in one IndexedDB transaction.
- **A change from a follower can reach the leader after its mark is cleared:** the leader pushes, finds nothing and clears the mark, and only then does the doc change arrive. So the leader checks every doc change (`ChangeOutbox.onDocChanged`) and marks whatever it finds unpushed.
- **Push** (`ChangeOutbox.pushItems`, leader only) reads `getChangesSince(doc, serverHeads)` under the item lock, groups the changes in order into rows of at most `MAX_INCREMENTAL_MESSAGE_BYTES`, and encrypts each row. Once the server has acknowledged every row of an item, its server heads become the heads the changes were read at, and its mark clears if its tick hasn't moved. Those are always heads the doc had at one moment, so they stay a frontier. A lost acknowledgement or a partial failure resends the same changes, which Automerge ignores as duplicates.
- **One exchange at a time.** Pushes come from polls, snapshot uploads and rewrites, and each `pollLog` also reads the log, so `SyncPoller.exchange` runs them one by one. An acknowledgement is recorded before the entries that came with it are applied, so that a pull sees the item as no longer pending.
- **A single change over the row limit** can't be split. The item takes the snapshot path (`snapshotOnly`), and its server heads become the snapshot's heads once it's confirmed. Other devices get the change at their next manifest sync, or sooner if a later row depends on it. A snapshot over the item limit goes to `recreateOversizedItem`.
- **Rows the server refuses** (400, 413 or 422, not an auth error or an outage) go the same way. `pushItems` retries a refused request one item at a time, and an item the server still refuses on its own becomes `snapshotOnly` for the session. Otherwise one such item would fail every push, and with it first start, for good. If its snapshot is refused too, `SnapshotPusher` quarantines it as usual.

### Inbound: `SyncLogPuller`

For each entry, in seq order: check contiguity, skip an own echo, decrypt, apply, then advance the cursor (debounced).

- **Own echoes** are seqs this device pushed, kept in a bounded set. They only advance the cursor, and they don't count as "another device" for clearing a `pullDecryption` quarantine.
- **Decryption always comes first.** `loadIncremental` applies what it can of truncated or garbage bytes rather than throwing, so AES-GCM authentication is what rejects a damaged row.
- **`docStore.applyIncomingChanges`** applies a row under the item lock. A loaded doc takes `loadIncremental`. Otherwise the row goes through `Automerge.init()`: `Automerge.load` throws on a partial incremental, so a row with missing dependencies parks and no empty doc is stored, and the rest goes through `hydrateAutomergeDocumentBinary`, which merges into stored data and refuses to create a doc over it (rule 2).
- **Applying never marks an item pending.** Server heads follow the doc only if the item isn't pending and the doc matched them before the row. A doc that didn't has changes of its own, whose mark may not have reached storage yet, and moving the heads past them would mean they're never pushed. A pending item that pulls changes resends them once, which Automerge ignores, and its acknowledgement moves its heads past them.

`hasImmediatePendingPulls` is true only for `hasMore`. Waiting on a gap is never "immediate" (rule 4).

### Gaps

A gap is a missing seq between the cursor and the next visible row.

- **Fresh gap.** The next visible row is under `gapWait` (30s) old by the server's clock (`serverNow − createdAt`), so the missing row may be part of a transaction that isn't fully visible yet. The cursor stays, and the orchestrator re-polls after 1s, 2s, 4s and so on, up to 16s. The poll still reports `'success'`.
- **Stale gap.** The next visible row is older than that, or a fresh gap has lasted that long. The row was lost, which can't happen by design, so the puller logs an error, moves past it and asks for a manifest sync now, ignoring `manifestSyncMinGap`. Missing-dependency checks catch the items affected.
- **Catch-up.** A device with no finished pull, or whose last one was more than `logCatchUpAge` (25 days) before `serverNow`, may be behind the TTL. It runs the same manifest sync before it reads, because the first visible row may still look contiguous. The poller checks the local clock first, and the server's once it has a response: a page that shows the device is behind is dropped and read again afterwards, because the manifest sync can't run inside an exchange. Until its first pull with `hasMore` false, a stale gap is expected, so it causes no error and no second manifest sync. Fresh gaps still wait.

### Parked entries and the `GapHealer`

An entry that can't be applied yet (a failed decryption, a missing key, missing dependencies or a doc that won't load) is parked and the cursor moves on. A parked entry keeps the row's ciphertext as it arrived, which the keyring can always read again, so it needs no seal, and it outlasts a reload rather than relying on Automerge's own queue of changes with missing dependencies reaching storage.

The `GapHealer` owns those items. It fetches an item's snapshot at once (`ManifestSyncManager.fetchSnapshots`), re-applies its parked rows in seq order and checks for missing dependencies. Rows stay until nothing is missing. If the server doesn't have the dependencies yet, some device's doc does, and it retries after every later entry for the item, every manifest sync, every keyring update, and on a backoff (`GAP_HEAL_DELAYS`). Work runs at the end of each poll, so a failure fails the poll.

- **After a day** (`missingChangesQuarantine`) the item is quarantined as `missingChanges`. It stays usable and keeps retrying, and a heal clears the quarantine.
- **A row that won't decrypt** is dropped after `MAX_PULL_RETRIES` (5) and the item quarantined as `pullDecryption`.
- **A row waiting for a key** is never quarantined. A keyring update retries it.

The Repo has no peer to ask for a doc it can't find, so a find for an indexed item with no local data (after `replaceFromServer`, say) also goes to the healer.

### Poll result contract

`executePoll` returns `'success' | 'failure' | 'auth-failure' | 'no-poll'`, which drives `SyncOrchestrator` backoff:
- `'success'` resets backoff. Return it only when the whole cycle had no errors.
- `'failure'` triggers exponential backoff. Return it whenever push, pull processing or healing throws.
- `'auth-failure'` pauses polling until a flush or restart, and tells the user the session has expired. Return it only when the server refused the session.
- `'no-poll'` leaves backoff unchanged, for example when the poll was aborted.

If any I/O throws and the poll still reports `'success'`, backoff resets while `hasImmediatePendingPulls()` stays true. The result is a 0ms re-poll loop.

**A refresh that gets no answer is an outage, not an auth failure.** Nothing restarts paused polling, so a device that paused because it couldn't reach the server would stop contacting it for good. So `handleSessionExpired` reports `unreachable` for a network or server error, leaving the session and telling the host nothing, and `SyncApiClient` rethrows the network error the worker's refresh fails with. The poll returns `'failure'` and keeps retrying until the server answers. The same goes for a refresh the main thread never answers, which is every refresh during startup, because the bridge can't reach the worker until the session is ready. A login during an outage depends on this: it has no token, and `navigator.onLine` may well be true, so no `online` event will come. When a refresh restores a session that had been lost, the bridge runs its reconnect steps, because any request can be the one that gets it back.

## Snapshot coverage

Snapshot uploads stay unconditional last-write-wins, hydration still merges, and versions stay monotonic. Three rules (`SnapshotCoverage`) keep each server snapshot a superset of every snapshot it replaced, and keep every change in some snapshot. That matters because a device that hydrates after the TTL has only snapshots to go on.

- **S1. Log before snapshot.** `SnapshotBuilder` builds a snapshot only when the doc has nothing after its server heads, checked in the same synchronous section as `Automerge.save`. Otherwise it returns `deferred`, and the caller pushes and builds again. So every change in a snapshot is already in the log. There are two exceptions: a single oversized change, and an `awaitingSnapshot` item at first start.
- **S2. Recheck after a version jump.** When `putSnapshots` returns `version > baseVersion + 1`, another device wrote in between and its snapshot is now gone. The device records `{ itemId, uploadedHeads, logSeq }`, where `logSeq` is the log's head after the write. Once its cursor reaches `logSeq`, the doc holds every change of the replaced snapshot: by S1 they were in the log before that snapshot was written. If the doc's heads then differ from `uploadedHeads`, the item is uploaded again, and each re-upload is checked the same way. `StoredSnapshotRecorder` covers uploads and rewrites alike.
- **S3. Backstop at manifest sync.** A device that holds a change must upload it if nobody else does. `ManifestSyncManager` marks an item dirty when its doc contains the server snapshot's heads and has other heads too. It checks snapshots newer than `baseVersion`, and items with pulled changes no snapshot has confirmed, which a device would otherwise never look at: their server version equals `baseVersion`. A pull that adds changes records `{ itemId, firstSeenAt }`, and after a day (`pulledChangesGrace`) the author has had its chance. A record goes once a snapshot's heads match the doc's.

**Why a stale snapshot can't stay stale.** In the race, A and B upload snapshots that each lack the other's change, and the later one wins. The later writer jumped a version, so S2 makes it catch up the log, receive the other's change by S1, and upload again. A writer without a jump had merged, or already contained, the snapshot it replaced, so it wrote a superset.

**Rewrites.** `ItemReencryptor` builds through the same `SnapshotBuilder`, so it runs on the leader once first start allows pushes (`FirstStart.whenReadyToPush`, after the network part's manifest sync), and pushes each chunk before it builds. It doesn't wait for first start's own push to finish: one item the server kept refusing would stall it for good, and S1 already defers anything the chunk's push didn't deliver. A deferred item is pushed and built again up to `MAX_BATCH_RETRIES`. After that, or for an `awaitingHeads` item, it goes in `failed` with no quarantine, so a later run can retry it. A push that fails on the network stops the run and schedules a retry.

Every wait is bounded for a caller that asks: with `waitTimeoutMs`, waiting for leadership or for first start gives up with a `ReencryptionWaitError` naming the stage, having changed nothing. `cancel` stops a run in flight (and any retry it scheduled) between chunks; otherwise a stuck run would be shared by the next caller through its `SingleFlightGuard`. `prepare` waits as a run would without rewriting anything, so the key rotation coordinator (`reencryptAllItems` in `keys/reencrypt.ts`) can stop before it rotates the key on a device that can't push. The run reports its stage (`waitingForLeader`, `waitingForSync`, `reencrypting`) as `reencryptStage` events, and `getSyncDiagnostics` reports it with the leadership and first start's state and last error.

## First start

The log started empty at the cut, and nothing was copied from `FlockSyncMessages`: snapshots carry the data across, and each device uploads what it has that they lack. `FirstStart` moves each device across once per account. Old server heads can't be trusted, because they can name changes only the old table held.

- **Local part** (`runFirstStartLocalPart`): inside the `withLocalDataLock` call that opens local storage, it records every active item as `awaitingHeads`, marks it pending, clears the old server heads and cursors, and persists `firstStartReset`. The flag comes last, so an interrupted run repeats, and it never runs again, because a later tab would otherwise clear heads the leader has set.
- **Network part** (`FirstStart.ensureSynced`, before the leader's first `pollLog`): it holds no lock, because it can wait indefinitely on an offline device. It runs catch-up's manifest sync, resolves each item from its manifest entry, pushes as normal and persists `firstStartSynced`. Then it clears any leftover WAL with `clearWriteAheadLog` and persists `walCleared`, retrying at the next start if that fails.

| Manifest entry | Result |
|---|---|
| Heads decrypt, and the doc has them | Set server heads to them and remove the record |
| Heads decrypt, but the doc lacks them | Stays `awaitingHeads`: the snapshot hasn't merged yet |
| No snapshot | Move to `awaitingSnapshot` and mark it dirty |
| No heads, or heads that fail in any other way | If the base version has reached the manifest's, move to `awaitingSnapshot` and mark it dirty. Otherwise stay, so an upload can't replace a snapshot the doc lacks |
| Key missing | Stays `awaitingHeads` |
| Quarantined | Stays `awaitingHeads`, with recovery |
| Deleted | Remove the record |

Records don't hold back polling or any other item. An `awaitingHeads` item goes through the table again after every manifest sync and keyring update. Until then push skips it, because it would send its whole history, and S1 defers its snapshot. An `awaitingSnapshot` item is exempt from S1 and isn't pushed, and its confirmed snapshot's heads become its server heads.

Two devices can upload an `awaitingSnapshot` item at once. S2 can't help, because the loser's changes never reached the log, but S3 does: its next manifest sync merges the winner, finds it has other heads too, and uploads again.

## Snapshot sync

- `SnapshotManager` debounces dirty items (30s default, 5 min max wait) and uploads encrypted full Automerge binaries. Failures back off at 2s → 5s → 10s → 30s → 60s. After `MAX_CONSECUTIVE_SNAPSHOT_FAILURES` (5, `SnapshotPusher`), the item is dropped from the dirty queue.
- When offline, the orchestrator stops polling and `SnapshotManager` halts retries. On reconnect, backoff resets and a poll runs immediately.
- **The sync indicator counts pending marks only** (`countUnpushedChanges`). A dirty item's changes are already in the log, so showing it would report edits as waiting for the whole debounce. `getUnsyncedChanges`, for removing an account or exporting a backup, counts dirty items too: a device that hydrates after the TTL has only snapshots to go on.
- **Poll cadence follows visibility.** The leader polls every 30s while any of the account's tabs on the device is visible, and every `hiddenPollInterval` (5 min) while none is. Failure backoff overrides both, and local edits still flush at once. When the user comes back to a tab (it becomes visible or gets focus), `SyncOrchestrator.onForeground` polls now and resets backoff, unless a poll is running or one finished in the last `foregroundPollMinGap` (10s). There's no server push: Web Push would show a notification for every nudge.

### Monotonic versions (no clock-based reconciliation)

`putSnapshots` runs an atomic `version = if_not_exists(version, 0) + 1` and returns the new version. The client stores it as `baseVersion` in its `lastModified` record. `calculateSyncDeltas` then decides:

| Condition | Action |
|---|---|
| V_server > V_base | Fetch the snapshot and merge it into the local doc |
| V_server > V_base and server deleted | Apply the tombstone locally |
| V_server ≤ V_base and dirty | Push a snapshot |
| V_server ≤ V_base and clean | Do nothing |
| Item missing from the server manifest | It was created offline, so push a snapshot |
| Quarantined, V_server ≤ max(V_failed, V_base) | Skip (unless forced) |
| Quarantined, V_server > max(V_failed, V_base) | Fetch the snapshot to retry recovery |

Physical timestamps (`localModifiedAt`, `serverTime`, `SKEW_BUFFER_MS`) remain only as a legacy fallback for records that have no version.

V_base advances only when this device pushes or hydrates a snapshot, not when the log delivers the same changes. So every item edited on another device looks stale, whether or not this device missed anything. **Heads in the manifest** keep that cheap:

- Each snapshot upload carries `heads`, the Automerge heads of the saved doc, encrypted with purpose `heads` (see "Doc-bound ciphertexts"). The server stores them with the snapshot and returns them in the manifest.
- Before computing deltas, `findSnapshotsCoveredLocally` decrypts the heads of each active, non-quarantined item with V_server > V_base and checks `Automerge.hasHeads` against the local doc. If the doc already has them, `ManifestSyncManager` raises V_base to V_server, and the table above then treats the item as up to date. A dirty item is still pushed, and a doc that holds more than the snapshot gets a new one (S3 in "Snapshot coverage").
- Anything that can't be checked (no heads, a missing key, a doc that isn't loaded, heads that fail to decrypt) is fetched as before. A heads failure never quarantines an item. Forced syncs skip the check.
- **Every write sets or removes `heads`** (`updateItemCommand`). Heads left from an older snapshot, paired with a newer version, would make clients skip a snapshot they need. A write without heads (older builds, tombstones, legacy writes) removes them, and the manifest leaves them out for deleted items.

A quarantined item's manual recovery entry records `serverVersion`, the server version that failed (for example a snapshot that couldn't be decrypted), as V_failed. A failed hydration doesn't advance V_base, so without it the same broken snapshot would be fetched and fail again on every manifest sync. Entries without `serverVersion` (stored before it existed, or quarantines not tied to a server version) fall back to V_base. The comparison never uses the entry's `createdAt`, which comes from this device's clock.

### Snapshot writes are intentionally LWW (no OCC)

`itemsRouter.putSnapshots` overwrites without a version condition. This is safe for four reasons:
- Snapshots are recovery baselines, and overwriting one never touches any client's local doc.
- Every edit reaches the log before any snapshot holds it (S1), and S2 and S3 catch up a snapshot that replaced another device's.
- Hydration merges rather than replaces (`existingHandle.merge(...)` / `Automerge.merge`). A stale snapshot cannot clobber newer edits, because merge(A+B, A) = A+B.
- When a client merges a stale snapshot, `hydrationResult.hasLocalChanges` is true, so it calls `markItemDirty` and re-uploads the merged state.

OCC would be harmful. A blind relay cannot resolve conflicts, so concurrent or offline flushes would churn on retries and eventually false-quarantine healthy items. OCC is reserved for centralized, non-CRDT state such as `keyringVersion` during key rotation.

## Deletion and IDs

- Deletes are soft-deletes. The CRDT doc gets `deleted: true`, and that propagates through messages and snapshots (`metadata.deleted`). `FlockItems` rows are never hard-deleted and have no TTL.
- The server never clears `metadata.deleted`. A later snapshot from a device that hasn't seen the delete yet replaces the stored snapshot (hydration merges, so that is harmless) but keeps the item deleted.
- A hard-delete would be undone. An item missing from the manifest looks like an offline creation, so manifest sync would re-upload it.
- Deletion is terminal, with no undelete. New items always get a fresh `generateItemId()` (126-bit nanoid). Reusing an ID would merge the old entity's history into the new one.
- `AutomergeDocStore.findOrCreateHandle` refuses to create a blank doc when `hasDataInStorage(itemId)`. This guard prevents data loss: without it, a handle-lookup timeout would overwrite an existing doc.
- Selectors filter `!item.deleted`, and `AutomergeIndexManager` excludes tombstones from the active index.

## Concurrent string edits

Item writes are diffs: `applyItemUpdatesToDraft` skips unchanged fields, so a whole-item save doesn't overwrite remote edits to fields it didn't change. Changed strings are handled in one of two ways:

- **Merged text.** Keys listed in `SyncDomain.mergedTextFields` go through `Automerge.updateText`, so concurrent edits merge character by character. This suits long free text, where keeping both edits matters more than a clean result. Edits to the same spot can interleave, and identical edits duplicate.
- **Everything else is replaced whole.** One concurrent edit wins, chosen by Automerge's op ordering rather than by time, so every device agrees but the older edit can win. Merging characters here would garble names, and would turn enums into invalid values: two devices both setting `all` would merge to `allall`, which fails validation.

New string fields are replaced whole unless the app lists them. A field that moves between the two needs no migration, because assignment and `updateText` both work on either kind of value.

## Account settings document

Account settings the app syncs (`SyncDomain.syncedMetadataKeys`) live in an encrypted Automerge document managed by `AccountSettings`. Other metadata keys stay in the device's local index. The worker merges both and emits them as `metadataUpdated`, with the document's values winning.

- **Fixed ID.** The ID is `settingsDocId(account)` (`settings-${account}`), so every device agrees on it without coordinating. This is the one exception to "never recreate a doc under an existing ID": two devices can create it concurrently, for example while migrating. Their histories merge because each setting is a top-level key. Two devices that first create the same nested object concurrently keep only one of them, so prefer flat values.
- **Created lazily, never deleted.** The document is created on the first write of a synced key and never seeded with defaults, which would overwrite real values from other devices. `forceDeleteRecoveryItem` and `recreateOversizedItem` refuse it.
- **Writes are diffs.** The app sends whole objects, so `AccountSettings` skips unchanged keys and edits nested maps and lists in place. Replacing a map would discard a concurrent edit to another field.
- **An ordinary document otherwise.** It is in the item index, so the log, snapshots, manifest sync, key rotation and backups all handle it. The worker filters it out of the `indexUpdated` event sent to the app (`SyncWorkerContextConfig.onIndexUpdated` still sees it, so the worker subscribes to it) and routes its changes to `AccountSettings` instead of `itemUpdated`. `withSettingsDocPassthrough` keeps it away from the app's codec.
- **Legacy migration.** After each manifest sync, so that the server's copy has been hydrated first, `migrateLegacySettings` copies settings from the app's `LegacySettingsSource` and from local metadata into the keys the document lacks, clears the source and then strips the local keys. Keys already in the document win, because another device migrated them first. A failure leaves everything in place for the next sync. Failures are logged and never fail the manifest sync.

## Doc-bound ciphertexts

Snapshots and log rows are encrypted with `vault-doc:<itemId>` as AES-GCM associated data and marked `format: 2`. Snapshot heads use `vault-heads:<itemId>` (purpose `heads`), so heads can't be served as a snapshot or the other way round (`DOC_BOUND_FORMAT` in `packages/vault-shared/src/crypto.ts`). Without it, the server could serve item A's snapshot as item B's, and B's device would merge A's whole history into B, which cannot be undone.

- **Bind the ID the plaintext is applied to.** `snapshotBuilder` and `ChangeOutbox` encrypt with the item ID; `ManifestHydrator`, `SyncLogPuller` and `GapHealer` decrypt with the ID of the doc they apply the result to. Taking the ID from a separate field in the server's response would defeat the check.
- **The flag cannot be used to downgrade.** Stripping `format` from a bound ciphertext makes it decrypt without associated data, which fails. An unknown `format` is rejected.
- **Unbound ciphertexts still decrypt for now**, because older snapshots are unbound. Until they are rejected, a malicious server can still serve unbound ciphertexts it kept. `SnapshotFormatUpgrade` rewrites every snapshot once per device after a manifest sync without failures (or one skipped because a clean sync ran within `manifestSyncMinGap`), when local docs include everything in the server's snapshots. It runs only in the leader tab and at most once per session, so a persistently failing item doesn't re-upload everything on every sync.
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
- `kind` is one of `pullDecryption`, `snapshotDecryption`, `oversized`, `snapshotFailure`, `pushFailure` (no longer written), `missingChanges` or `unknown`. For legacy entries it is inferred from the reason text.
- `pullDecryption` is auto-cleared only by a successfully applied entry from another device. Own push echoes are excluded via `SyncLogPuller.recordOwnPushes`. The `GapHealer` clears `missingChanges` when it heals the item.
- A server-confirmed snapshot upload clears every kind, as does any explicit user action (retry, overwrite, delete, recreate, dismiss).
- `serverVersion` (optional) is the server version that failed; manifest sync skips the item until the server has a newer one (see "Monotonic versions"). An upsert keeps the highest version seen, even when a weaker kind doesn't replace the entry.
- A weaker quarantine never overwrites an `oversized` entry. Oversized detection (`SnapshotTracker`, `DataRecoveryDialog`) checks `kind`, never reason text.

## Multi-tab and leader election

- `LeaderElection` uses `navigator.locks`. Only the leader runs the `SyncOrchestrator` poll loop. Followers keep a live Repo and sync with other tabs over `EncryptedBroadcastChannelNetworkAdapter`.
- Only tabs with `isLeader === true` send heartbeats on the presence channel. A leader that yields to a higher-priority `claim` calls `revokeLeadership(false)`, which keeps the presence channel and heartbeat timer so it can detect a crash of the new leader.
- `onMultipleLeadersDetected` must fire only when there are genuinely 2+ active leaders. A follower receiving the sole leader's heartbeat does not count.
- Every tab runs a `ForegroundTracker`, which sends `tab_visibility` messages on the `RealtimeBus` sync channel when its visibility changes and every 30s while it's visible, so a hidden leader keeps the foreground cadence for a visible follower. A tab that stops pinging counts as hidden after 75s. A follower the user comes back to sends `returned`, and the leader polls for it.

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
- Sync log database (`syncLogDatabase` + account), which `SyncLogDatabase` opens directly rather than through localforage: pending marks, parked entries, first-start records, S2 rechecks and S3 records. None of it needs a seal: it holds IDs, heads and counters, and parked entries hold the server's ciphertext.
- A WAL left by an older build, in its own databases, until first start clears it. Nothing reads it.
- Sync metadata: one database per account, `flock-sync-metadata-${accountId}` in Flock (store `sync-metadata`), opened once via `getSyncMetadataStorage(accountId)`. Its keys are `logCursor`, `logLastPullAt`, `indexDoc` or `indexDocSealed`, `lastModified` (including `baseVersion`), `syncedHeads`, `snapshotsDocBound`, `deviceDataVersion`, `firstStartReset`, `firstStartSynced` and `walCleared`. The stores only read the current layout.
- Sealed storage (`upgradeLocalEncryption`, docs/local-encryption.md Part 2): user content is sealed with a per-device storage key (DSK), wrapped with a data key and kept in the sealed Automerge database's `meta` store (`dsk`, plus `upgradedAt`).
  - **What's sealed:** Automerge chunks go to the sealed Automerge database (`sealedAutomergeDatabase`) as `{ key, v, iv, ct }`. The index is sealed under `indexDocSealed`.
  - **What stays readable:** storage keys, the sync log database and the other metadata keys hold no user content.
  - **Associated data:** each record is bound to its account, store and position, so a record moved anywhere else fails to open.
  - **`openLocalStorage`** picks sealed or plaintext storage under the `localDataMigrationLock`, after the `migrateLocalData` hook and before the Repo exists. It copies any plaintext data across and retires the plaintext stores once no other engine holds the account's sync locks.
  - **Decrypt failures:** a record that fails to decrypt is never treated as missing. The document is quarantined as `localDecryption`, and if the DSK itself can't be opened, sync stops and the app is asked (`onLocalDataUnavailable`). Nothing is ever reset automatically.
- Older layouts: the worker config's `migrateLocalData(accountId)` hook runs at the start of `SyncWorkerContext.initialize()`, before any store is read, under the `localDataMigrationLock` Web Lock so tabs take turns. A failure fails initialization, because starting would create an empty index that a later migration would keep over the old one. Flock passes this hook only in its migration app (`src/migrate/legacy/localData.ts`). It imports Flock's per-store databases, the consolidated store's earlier keys and old value shapes, and deduplicates manual recovery entries (its own `manualRecoveryMigrated` key).
- Data levels: with `minDataVersion` set, `initialize()` first checks `deviceDataVersion`. Below the minimum, a device with an index, or with data the app's `hasLegacyLocalData` hook finds, doesn't start: the worker emits `migrationRequired` instead. This check has to come first, because starting records the current level for a device with no index. Likewise, a server row without a snapshot, when the app has no `decodeLegacyItem` hook, is skipped rather than quarantined and reported as `migrationRequired` (see "Backwards compatibility" in `docs/vault-extraction.md`).
- All storage names come from `VaultStorageNames` (`packages/vault-client/src/shared/storageNames.ts`). Renaming one orphans the data stored under the old name.
- Logout or reset: `clearAccountLocalData` → `clearSyncMetadataStorage` drops the whole metadata database. The store-level `.clear()` only clears its own key.

## Shutdown order (`ServiceLifecycleManager`)

- Each session's components share one `SyncSessionState` (online, leader, shut down) and take the account in their constructor; a new account gets a new context. `SyncWorkerContext.shutdown` marks the session shut down first, so no component starts new work, then the lifecycle stops each component exactly once, in reverse registration order. Nothing else stops a component: a second stop with other options (such as without `clearLocalData`) could save state during a data clear.
- The context's `RealtimeBus` (cross-tab sync pings, item-dirty, index and metadata messages) is registered first, so it closes last.
- Shut down the Automerge Repo before clearing IndexedDB. Otherwise pending saves write data back into the cleared database.
- Don't run `clearSyncMetadataStorage` (`dropInstance`) concurrently with per-store `.clear()` calls on the same database.
- The sync log database closes after everything that writes to it, because an open connection blocks `deleteDatabase`. Its connection also closes itself on `versionchange`.

## Event hub concurrency

`ClientEventHub.emit` is fire-and-forget. Async listeners are not awaited, and their rejections are caught and logged. This keeps producers such as item updates and request tracking from being slowed by listener I/O. Listeners must therefore handle concurrent in-flight invocations themselves, using `SingleFlightGuard`/`KeyedSingleFlightGuard`, `AsyncMutex`/`KeyedAsyncMutex`, `ItemLockCoordinator`, `AsyncQueue` or monotonic tick counters (for example `SnapshotTracker.dirtyItemsTick`).

Inside the worker, components call each other through plain callbacks that `SyncWorkerContext` wires up. A callback that starts async work runs it with `fireAndForget`, so the same applies to it: pushes, pull processing and Repo network events aren't slowed by it, and it must synchronize itself.

## Server limits

- `appendLog` writes at most 99 rows and about 3.5 MB per transaction, under the `TransactWriteItems` limits, and retries with jitter on a conflict. `ChangeOutbox` sends requests within `logPushRows` and `logPushChars`.
- `fetchSnapshotsByIds` chunks reads into groups of 100, the `BatchGetItem` limit.
- `UnprocessedKeys` are retried with jittered exponential backoff.

## Other recovery

- Worker health (`SyncWorkerHealthMonitor.ts`) sends a 15s ping and treats a 30s silence as a timeout. A crashed worker is auto-restarted up to `MAX_CONSECUTIVE_CRASHES` (3) times.
- `ManifestSyncManager` reconciles at startup, every hour (`manifestSyncInterval`) and when the user comes back to a tab (`onForeground`). Each run is skipped within `manifestSyncMinGap` (50 min) of the last clean one, unless it's forced or the device has no items. The gap is shorter than the interval so the hourly timer always runs.
