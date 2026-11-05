# Sync Log Plan: Outbound From the Doc, One Ordered Log per Account

An implementation plan for two changes to the sync engine, and for closing two gaps in it. Read [sync-design.md](sync-design.md) first, because this plan changes several of the rules it explains.

- **A. Build outbound changes from the doc, not the WAL.** The worker stops driving Automerge's sync protocol against a pretend "vault" peer and stops storing message bytes. For each item it records which heads the server already has, and at push time it saves the doc incrementally from those heads. Snapshots plus incremental saves replace snapshots plus sync messages.
- **B. Keep one strictly ordered log per account.** The server gives each pushed message the next number in a gap-free sequence for the account, and readers see the messages in that order. This replaces the cursor built from a timestamp and a random offset, the eventually consistent `AccountCursorIndex` and the settle window.
- **A hard cut.** Old and new never run side by side. One release moves to the new table and format and forces every build onto it with `MIN_PROTOCOL_VERSION`. Nothing is copied from the old table: snapshots carry the data across, and each device's first start on the new build uploads whatever it has that they lack.
- **Problem 1:** a stale server snapshot can stay stale for good. The concurrent-snapshot race and the heads-covered shortcut combine so that nobody re-uploads.
- **Problem 2:** a skipped message takes up to an hour to heal, and nothing detects the skip.

Out of scope: S3 snapshots, snapshot frequency, manifest deltas, a WebSocket nudge and faster bootstrap. Nothing here makes them harder.

## Target design

### Terms

- **Log.** The new `FlockSyncLog` table: `account` (hash key) and `seq` (range key, a number). It holds the account's messages in commit order and expires them after `SYNC_LOG_TTL_DAYS` (30). It starts empty at the cut.
- **seq.** The position of a row in the account's log, starting at 1. Seqs are contiguous: every committed push uses exactly the next seqs, and a failed push uses none.
- **Head row.** The row `{ account, seq: 0, head }`, which holds the last seq used. Only log appends write it. It doesn't live on the `FlockAccounts` record, because `extendSession` writes that record on every authenticated request, and a standard write to an item in a running transaction fails with `TransactionConflict`.
- **Server heads (per item).** Heads whose every ancestor is on the server, in the log or in the item's current snapshot. They live in `SyncedHeadsStore`. Its existing data doesn't carry over, because it can name changes that only the old table held (see "First start").
- **Pending (per item).** The item may have local changes after its server heads. This is a hint: a false positive costs one empty check at push time. Applying pulled changes never sets it.
- **First-start record (per item).** `{ itemId, state }`, where `state` is `awaitingHeads` or `awaitingSnapshot`. It says the item's server heads aren't known yet, so the item can't be pushed (see "First start"). It holds only IDs, so it needs no seal.
- **Log cursor.** The highest seq this device has processed, persisted as one number.

### B: the server log

**Append.** One `TransactWriteItems` per push of at most 99 rows and about 3.5 MB (both under the transaction limits):

1. `Update` the head row: `SET head = :expected + :n`, with the condition `head = :expected` (or, for the first append, `attribute_not_exists(head)` with `:expected = 0`).
2. One `Put` for each message, at seq `:expected + 1 … :expected + n`, with the condition `attribute_not_exists(seq)`. A row holds `itemId`, `encryptedMessage` (shape unchanged, `format` included), `createdAt` and `expiresAt`.

The Lambda reads `head` with a consistent `GetItem`, builds the transaction and retries with jitter (up to 8 attempts) on `TransactionCanceledException`, rereading `head` each time. Pushes from a few devices of one user rarely collide. A push larger than one transaction becomes several transactions in a row, and its results report each message's seq.

**Read.** A `Query` on the base table with `account = :a AND seq > :after`, `ConsistentRead: true` and `Limit: 200`. There's no GSI, page token or settle bound. The response carries `hasMore` and the server's clock (`serverNow`).

**Why readers see seqs in order.** A transaction for seqs `e+1…` can commit only while `head = e`, which is true only after the transaction for `…e` has committed. So commits happen in seq order. DynamoDB documents `Query` as read-committed with respect to transactions, which may let one `Query` see some rows of a multi-row transaction and not others. Contiguity makes that harmless: the client never moves past a missing seq (see "Gaps").

**Row contents.** A row's `encryptedMessage` is a run of Automerge change chunks, encrypted with the item's ID (rule 9). There's no sync message and no batch framing, and there's only one kind of row. An item's change set can span several rows, in dependency order.

**API (protocol 5).** One mutation, as today:

```
sync.pollLog({ account, push: [{ itemId, encryptedMessage }], after: seq })
  → { pushResults: [{ itemId, seq }], entries: [{ seq, itemId, encryptedMessage, createdAt }],
      hasMore, serverNow }
```

`items.putSnapshots` also returns `logSeq`: the head read with a consistent `GetItem` after the writes. It's used by "Snapshot coverage" below.

### A: outbound from the doc

**Pending tracking (`ChangeOutbox`, new).**
- Every local change marks the item pending: the paths that call `markDocumentDirty` today, changes that reach the leader from follower tabs, and hydrations that report `hasLocalChanges`.
- Pending marks live in a new object store with one record per item, `{ itemId, tick }`, so tabs never race on a shared value. Followers write marks too, so an edit survives a leader that crashes before it pushes.
- The records hold only IDs, heads and counters, which [local-encryption.md](local-encryption.md) already allows unsealed.
- Server heads stay in `SyncedHeadsStore`.

**Push (leader only, in `SyncPoller`).** For each pending item with no first-start record:

1. Under the item lock, compute `changes = Automerge.getChangesSince(doc, serverHeads)` and `heads = Automerge.getHeads(doc)`.
   - No changes: clear the mark if its tick is still the one read (a conditional delete in one IndexedDB transaction).
   - A single change over `MAX_INCREMENTAL_MESSAGE_BYTES`: the item skips the log and takes the snapshot path (see "Oversized changes").
2. Group the changes, in the order returned, into rows of at most `MAX_INCREMENTAL_MESSAGE_BYTES`. Concatenate each group's chunks, encrypt it with the item's ID and push it. Most change sets are one row.
3. When the server acknowledges every row of the item, set server heads to `heads` and clear the mark if its tick is unchanged. If only some rows were acknowledged, nothing changes locally.
   - Server heads are always heads the doc had at one moment, so they stay a frontier.
   - A lost acknowledgement or partly failed push makes the next push resend the same changes, which Automerge ignores as duplicates.

A failure before the acknowledgement changes nothing locally. There's nothing to prune, mark in flight, check or compact, because the doc stays the only copy (rule 1).

**Pull (leader only, `SyncLogPuller`, new).** For each entry, in seq order:

1. **Contiguity.** If `entry.seq ≠ cursor + 1`, stop and handle the gap (see "Gaps").
2. **Own echo.** A seq this device pushed (kept in a bounded set) only advances the cursor. It still counts as "own" for the rule that only `pullDecryption` from other devices auto-clears a quarantine.
3. **Decrypt** with the entry's `itemId` (rule 9). A missing key or failed decryption **parks** the entry (below) and moves on; it never blocks the cursor.
4. **Apply** with `docStore.applyIncomingChanges(itemId, bytes)`, under the item lock:
   - **Loaded handle:** `handle.update(d => Automerge.loadIncremental(d, bytes))`.
   - **Otherwise:** apply the bytes to `Automerge.init()` the same way. If that leaves missing dependencies, park the entry and send the item to the `GapHealer`, so no empty doc is stored. If not, `save` the result and pass it to `hydrateAutomergeDocumentBinary`. That function already merges into existing data and refuses to create a doc over stored data (rule 2, `hasDataInStorage`).
5. **Server heads.** If the item isn't pending, set its server heads to the doc's heads. If it is, leave them alone: the next push resends the pulled changes once, which Automerge ignores, and its acknowledgement moves server heads past them.
6. **Missing dependencies.** Check `Automerge.getMissingDeps(doc, [])`. If anything is missing, park the entry and send the item to the `GapHealer` (below).
7. Advance and persist the cursor (debounced, as today).

`hasImmediatePendingPulls` is true only when `hasMore` is true. Waiting on a gap is never "immediate" (rule 4).

**Automerge behaviour this relies on.** A probe on Automerge 3.4.1 showed:

- `saveSince` returns concatenated change chunks, and its size is close to a sync message's (6,714 against 6,753 bytes in one test). The push builds the same thing by concatenating `getChangesSince` output. The probe didn't test that hand-built form, so the "Split change sets" spec must.
- `loadIncremental` applies those chunks to a doc that has their dependencies, ignores duplicates and merges into concurrent edits.
- Without the dependencies, it queues the changes and `getMissingDeps` reports them. The queue survived `save` and `load`, and the changes applied once the parents arrived.
- `Automerge.load` throws on a partial incremental, so it must never receive one (hence step 4).
- `loadIncremental` doesn't throw on truncated or garbage bytes: it applies what it can. AES-GCM authentication is what rejects a damaged row, so decryption must always run first.
- `getChangesSince` and `saveSince` return the whole history, without throwing, for heads the doc lacks as well as for empty heads. So server heads must be heads the doc has, and an item whose server heads aren't known must not be pushed.

**Repo wiring.** The Repo keeps only `EncryptedBroadcastChannelNetworkAdapter`. Followers already sync through it, and the leader's doc holds every follower change, so the leader can compute every outbound change.

A `find` for an indexed item with no local data (after `replaceFromServer`, for example) used to reach the vault peer as a `request`. Now it asks the `GapHealer` to fetch the item's snapshot.

### Gaps

A **gap** is a missing seq between the cursor and the next visible row.

- **Fresh gap.** The next visible row was created less than `GAP_WAIT_MS` (30 s) ago by the server's clock (`serverNow − createdAt`). The missing row may be part of a transaction not fully visible yet. Keep the cursor, schedule a re-poll after 1 s, 2 s, 4 s and so on (not 0 ms, and not an immediate pending pull), and report the poll as `'success'` only if everything else succeeded.
- **Stale gap.** The next visible row is older than `GAP_WAIT_MS`, or a fresh gap has lasted that long. The row was lost, which can't happen by design, so log an error. Move the cursor past the gap and run a manifest sync now, ignoring `manifestSyncMinGap`. Missing-dependency checks catch the items affected.
- **Catch-up.** A device with no log cursor, or a last successful pull more than 25 days before `serverNow`, may be behind the TTL. It runs the same manifest sync before pulling, because TTL may have removed rows it never read, and the first visible row may still look contiguous. Until its first pull with `hasMore` false, a stale gap is expected: it moves past the gap with no error and no second manifest sync. Fresh gaps still wait, because a row near the head may only be in flight.

### Parked entries and the `GapHealer`

**Parked entries** are entries that couldn't be applied yet: decryption failed, the key version is missing, or dependencies are missing. They go to a new local store, keyed by `seq`, with `itemId` readable. Each one keeps the row's `encryptedMessage` as it arrived, and is decrypted again when it's retried. That's ciphertext under the account's data keys, and the keyring keeps every version, so nothing is written in the clear (rule 10) and the store needs no cipher. A plaintext session (the quota fallback or the password-derived-key guard) uses the same store, and there's nothing to copy when that device seals later. Parking keeps changes with missing dependencies across reloads, rather than relying on Automerge's own queue of them reaching storage.

The **`GapHealer`** (new) owns the items that have parked entries or missing dependencies:

1. **At once** (not at the next hourly manifest sync), fetch the item's snapshot (`fetchByIds`, through the `ManifestHydrator` merge path) and merge it.
2. Re-apply the item's parked entries in seq order, then check missing dependencies again. Remove the entries that applied.
3. **If dependencies are still missing,** the server doesn't have them yet. Some device's outbox still holds them, and it can't lose them, because they come from its doc. Retry steps 1–2:
   - after every later log entry for the item;
   - after every manifest sync;
   - after a keyring update (for missing-key entries);
   - on a backoff timer (1 min, 5 min, 15 min, then hourly).
4. **After 24 hours,** quarantine the item as a new kind, `missingChanges`, with the reason "waiting for changes from another device". The item stays usable and keeps retrying. A successful heal clears the quarantine.
5. **Decryption failures** keep today's limit of `MAX_PULL_RETRIES` and `pullDecryption` quarantine. An inbound message from another device that parses still auto-clears it.

### Snapshot coverage

Snapshot uploads stay unconditional last-write-wins, hydration still merges, and versions stay monotonic. Three rules keep each server snapshot a superset of every snapshot it replaced, and keep every change in some snapshot:

- **S1. Log before snapshot.** `SnapshotBuilder` builds an item's snapshot only when `getChangesSince(doc, serverHeads)` is empty. It checks that in the same synchronous section as `Automerge.save`. Otherwise it returns a new `deferred` result, and the caller pushes the log first and builds again. So every change in a snapshot is already in the log. There are two exceptions: a single oversized change, and an `awaitingSnapshot` item at first start, whose server heads aren't known (see "First start").
- **S2. Recheck after a version jump.**
  - When `putSnapshots` returns `version > baseVersion + 1`, another device wrote in between, and its snapshot is now gone. Record `{ itemId, uploadedHeads, logSeq }`.
  - Once the log cursor reaches `logSeq`, the doc holds every change of the replaced snapshot: by S1, they were in the log before that snapshot was written, which came before this write.
  - If the doc's heads then differ from `uploadedHeads`, mark the item dirty and upload again. Each re-upload is checked the same way, and the loop ends when no other device writes concurrently.
  - Persist these records with the snapshot tracker's state, so a reload doesn't drop them.
- **S3. Backstop at manifest sync.** Snapshots are the only lasting copy on the server, so a device that holds a change must upload it if nobody else does. An item whose doc contains the server snapshot's heads but has *other* heads too (`!areHeadsEqual(getHeads(doc), serverHeads)`) is marked dirty with the upstream debounce, as well as having its base version raised. Two sets of items get this check:
  - **Snapshots newer than `baseVersion`.** `findSnapshotsCoveredLocally` already looks at these.
  - **Items with pulled changes no snapshot has confirmed.** `findSnapshotsCoveredLocally` leaves these out, because their server version equals `baseVersion`: a device that pulls an author's change and then never sees a new snapshot would never check. So a pull that adds changes records `{ itemId, firstSeenAt }` in an unsealed local store. Once a record is a day old, the author has had its chance, and the check runs at each manifest sync. A record is removed when a snapshot's heads contain the doc's.

  This catches whatever S1 and S2 can't: quarantined uploads, S2 records lost before they ran, and authors who never came back.

**Rewrites.** `ItemReencryptor` builds through the same `SnapshotBuilder`, for a key rotation, for `reencryptOutdatedItems` in the migration app and for `SnapshotFormatUpgrade`. It can't just accept a deferral: `processChunk` counts any result but success as a build failure and quarantines the item as `snapshotFailure`, so a deferred item would be quarantined and its migration blocker would stay. So:

- `run` first waits for the network part of first start, honouring the caller's `signal`. It doesn't wait for every record to clear, or one missing key would stall the migration for good.
- A rewrite runs on the leader, because only the leader pushes. A follower claims leadership first (`claimLeader`). The migration app and `SnapshotFormatUpgrade` already run as the leader.
- Each chunk pushes its pending items to the log before it builds (`ChangeOutbox.pushItems`).
- A `deferred` result pushes and builds again, up to `MAX_BATCH_RETRIES`. After that, or for an `awaitingHeads` item, the item goes in `failed` with no quarantine, so a later run can retry it. `SnapshotFormatUpgrade` already retries next session.
- A push that fails on the network stops the run and schedules a retry, as going offline does today.
- An `awaitingSnapshot` item needs no push: the rewrite is its snapshot.

S2 lives in the `StoredSnapshotRecorder`, which `uploadSnapshotBatch` calls for both paths, so a rewrite that jumps a version is rechecked too.

**Oversized changes.** A single change too big for a row can't be split. The client uploads a snapshot instead, and sets server heads to the snapshot's heads once it's confirmed. If the snapshot is over the item limit too, `recreateOversizedItem` moves the item to a new ID (rule 2). Nothing is written to the log. Other devices get the change at their next manifest sync, or sooner if a later row depends on it, because the missing-dependency check sends the item to the `GapHealer`, which fetches the snapshot at once.

## Why problems 1 and 2 don't remain

**Problem 1 (a stale snapshot stays stale).** In the race, A and B upload snapshots S_A and S_B, each missing the other's change, and the later one wins.

- **The later writer jumps a version.** Its base came before the other's write, so S2 makes it catch up the log, by S1 receive the other's change, and upload again.
- **A writer without a jump** had merged, or already contained, the snapshot it replaced. Its base version was raised only by its own write, a hydration or a heads-covered check, and each of those means its doc includes that snapshot. So it writes a superset.
- **Conclusion:** every snapshot write is a superset of the one before. Every change is in its author's next snapshot (the author is dirty, and S1 makes the change reach the log first). S3 catches residual cases at every device's manifest sync.

So a device that hydrates only from snapshots after the TTL has expired still gets every change.

**Problem 2 (skipped messages, undetected, healed hourly).**

- **The skip itself:** B removes its cause. Seqs commit in order, readers use strongly consistent queries on the base table, and the cursor never moves past a missing seq.
- **Detection:** the cases where changes still fail to arrive are all detected within one poll:
  - TTL expiry (catch-up);
  - a lost row (stale gap);
  - a message that can't be decrypted or depends on changes the log lacks (parking and missing-dependency checks).
- **Healing:** the `GapHealer` fetches the snapshot at once, keeps parked changes across reloads, and retries on every relevant event rather than hourly.
- **Surfacing:** a gap that only another device can fill is shown to the user after 24 hours rather than left silent.

## Rollout: one hard cut

Everything below ships as one release, built on a branch in this order. There are no dual writes, no backfill and no code that reads the old format. Snapshots are the only bridge.

### Server

- **Infrastructure:** in `sst.config.ts`, add `FlockSyncLog` (`account` S, `seq` N, TTL on `expiresAt`, no GSI). Add its definition to `getVaultTableDefinitions` (`tables.ts`), so `yarn initdb` and `vitest.dynamodb.ts` create it.
- **Driver:** in `packages/vault-server/src/drivers/dynamo/syncLog.ts`, add `appendLog` (the transaction and retries), `readLog` and `readLogHead`. Add these to `VaultDriver` and to the `SyncRepository` pick.
- **Service and router:** add `syncLogService.ts` with `pollLog`, and the `sync.pollLog` procedure.
- **`putSnapshots`** returns `logSeq` (`items.ts`, `snapshotService.ts`).
- **Shared** (`packages/vault-shared`): schemas for `pollLog` and `logSeq`; `VAULT_PROTOCOL_VERSION = 5`.
- **Force the cut:** set `MIN_PROTOCOL_VERSION = 5` in `src/vault/api/index.ts`.
- **Remove** `syncService.ts`, the old driver methods, the page tokens and the `FlockSyncMessages` definition in `tables.ts`.
- **Remove the `backfillSyncMessageAccounts` migration** (`src/vault/migrations/index.ts`), which isn't needed once the table is gone. It's the last reader of `FLOCK_TABLES.syncMessages`, so the `syncMessages` table name can then go too: from `VaultTableNames`, `SYNC_MESSAGES_TABLE`, `FLOCK_TABLES`, the test setups and the Lambda environments in `sst.config.ts`.
- **Keep `sync.pollSync` as a stub.** The version check is middleware on the procedures, so an old build calling a removed procedure gets `NOT_FOUND`, which it treats as a failed poll, and it never learns to update. With a stub, it gets `CLIENT_OUTDATED` and reloads.

### Client

- **Outbound and inbound:** add `ChangeOutbox`, `SyncLogPuller`, `GapHealer` and `applyIncomingChanges`, and S1–S3.
- **Remove:**
  - `VaultNetworkAdapter`, `SyncMessageBroker`, `SyncWriteAheadLog`, the WAL part of `StorageRecoveryService`, and their specs (`walThrashingPrevention.spec.ts`, `globalPullPagination.integration.spec.ts`, the WAL parts of `sync.integration.spec.ts`);
  - `SyncPullQueueManager`, `PullCursorState`, `BatchProgress`, `binaryFraming.ts`, `messageParser.ts` and their specs;
  - the sync-state persistence that `isEphemeral: false` caused.
  - Keep `BaseSyncNetworkAdapter`, which the broadcast adapter extends.
  - Keep `shared/writeAheadLogStorage.ts`: `clearWriteAheadLog` clears WALs left on devices, for first start, local data cleanup and `keys/vault.ts`.
  - `LocalEncryptionUpgrade` loses `copyWal` and keeps `hasWal` (see "The WAL at the cut").
- **Storage names:** add the log cursor, parked-entry, S2, S3 and first-start names to `storageNames.ts`. Old names stay registered for cleanup (new names only; never rename one). Clear every new store in `clearAccountLocalData`.
- **Backups:**
  - `exportSyncState` stops exporting `pendingSync`, and `restoreSyncState` ignores it. `BackupSyncStateSchema` makes the field optional, so old backups still parse.
  - The "unsent offline changes" warning in `useBackupAndRestore` reads the unsynced count instead of `pendingSync`.
  - Restored items are marked pending and dirty for a snapshot. Their server heads are unknown, so the push either finds the changes after the stored heads or falls back to the snapshot.
  - The backup's cursors are never imported into the log cursor (an existing rule).
- **Unsynced counts:** `countUnsyncedChanges`, `reportLocalDataUnavailable` and the "discard local data" dialog count outbox records instead of WAL entries. All of them stay readable without the DSK.
- **Migration app:** it has no sync code of its own to port. `migrate.worker.ts` runs the same engine through `exposeSyncWorker`, so it gets `pollLog` and first start, and a device below `MIN_DATA_VERSION` runs first start there. Its rewrites follow "Rewrites" above.
  - `src/migrate/setup.ts` sets `onClientOutdated`. Without it `configureVaultHost` doesn't listen for the event, so a migrate tab left open across a deploy is refused on every write and never reloads. It calls `handleClientOutdated` with `applyUpdate: () => window.location.reload()`, and `MigrateApp` shows the warning. `forceAppUpdate` wouldn't work there, because that page never calls `registerAppUpdates`. A plain reload is enough: `/migrate/` navigations are `NetworkOnly` and its assets have hashed names, so a reload gets the new build.
- **Refused rewrites:** `ItemReencryptor.describeUploadFailure` rethrows `CLIENT_OUTDATED`. Today it counts as a permanent failure, which quarantines the batch as `snapshotFailure`.

### First start

Each device does this once per account, in two parts. The local part is short and holds the lock. The network part can wait indefinitely on a device that's offline, so it holds no lock: under `localDataMigrationLock` it would stop the account's other tabs starting, in the main app and the migration app.

**Local part.** It runs in `initializeLocalData`, inside the `withLocalDataLock` call that opens local storage, straight after `openLocalStorage`. Leadership is only claimed later, so this doesn't depend on it: the first tab to get the lock does the work, and later tabs see the flag and skip it.

1. **Record every active item.** Write a first-start record in state `awaitingHeads` and a pending mark for each. Pending is a hint, and until the records clear the unsynced count errs high, which is the safe direction for the "discard local data" dialog.
2. **Reset the sync state.** Clear server heads and the old cursors. The old server heads can't be trusted: they can name changes that only the old table held, which no device can read now. The log cursor starts empty, so the device is in catch-up.
3. **Persist `firstStartReset`.** This comes last, so an interrupted local part runs again. Once it's set, the reset never runs again, because a later tab would otherwise clear heads the leader has set.

**Network part.** The leader runs it before its first `pollLog`, whenever `firstStartReset` is set and `firstStartSynced` isn't. Offline it waits, like any sync. Other tabs start normally, and edits only mark items pending.

4. **Run catch-up's manifest sync.** Snapshots newer than the local copy merge into the doc, as they do today. A sync that fails outright retries with backoff (rule 4). One that fails for some items counts as run: those items stay `awaitingHeads`.
5. **Resolve each `awaitingHeads` item** from its manifest entry:

   | Manifest entry | Result |
   |---|---|
   | Heads decrypt, and the doc has them (`Automerge.hasHeads`) | Set server heads to them and remove the record. |
   | Heads decrypt, but the doc lacks them | Stays `awaitingHeads`: the snapshot hasn't merged yet. |
   | No snapshot | Move to `awaitingSnapshot` and mark it dirty. |
   | No heads, or heads that fail in any other way (`decryptSnapshotHeads` also throws on failed decryption and malformed heads) | If the doc has merged this snapshot (the item's base version has reached the manifest's), move to `awaitingSnapshot` and mark it dirty. Otherwise it stays `awaitingHeads`, so an upload can't replace a snapshot the doc lacks. |
   | Key missing (`MissingKeyError`) | Stays `awaitingHeads`. |
   | Quarantined | Stays `awaitingHeads`, with recovery, as it does today. |
   | Deleted | Remove the record. |

   Expect most items to have no heads. Heads only arrived in 4d3f30b0 (2026-11-03), and only a snapshot written since carries them. So the first device to start uploads a snapshot of most items, and later devices merge those and find heads.
6. **Push as normal.** `getChangesSince(doc, serverHeads)` is empty for an item that matches its snapshot, which clears the mark. Anything else goes to the log, split across rows if needed, and is marked dirty for a snapshot. A single oversized change takes the snapshot path. Other devices get these changes in seconds.
7. **Persist `firstStartSynced`.** Polling and rewrites start. An interrupted network part runs again from step 4, and items already resolved stay resolved.
8. **Clear the WAL** (see "The WAL at the cut").

**Remaining records.** First start is finished when no records are left. Records don't hold back polling or any other item:

- An `awaitingHeads` item goes through step 5 again after every manifest sync and every keyring update, at this start or a later one. Until then push skips it and S1 defers its snapshot. Without this it would have no server heads, and a push would send its whole history.
- An `awaitingSnapshot` item is exempt from S1, and it isn't pushed. When the server confirms its snapshot, server heads become that snapshot's heads and the record goes. A confirmed tombstone also removes the record.
- Items with a record stay pending, so a pull leaves their server heads alone.

If two devices upload an `awaitingSnapshot` item at once, the later snapshot wins. S2 can't help, because the loser's changes never reached the log. S3 does: the loser's next manifest sync merges the winner, finds it has other heads too, and uploads again.

**Why nothing is stranded:**

- **Unpushed edits** are in the author's doc, so they're pushed, or carried by its snapshot if the server's snapshot has no heads.
- **Messages in the old table that no snapshot holds** are in the doc of the author and of any device that pulled them. The first of those devices to start the new build pushes or uploads them.
- **Items a device can't resolve yet** keep their record and stay pending, and they're retried.
- **Concurrent differences** between devices each get pushed by the device that has them, and S1–S3 bring the snapshot up to date.
- **A device left on an old build** keeps editing locally. Its writes are refused until it reloads, and then this runs. Reads stay open to old builds, so they never see an error that touches local data.

So every device converges once it has started the new build and the devices it depends on have too.

### The WAL at the cut

The WAL isn't migrated. Its entries are never read, and nothing replays them, because snapshots and each device's doc carry the data across (see "Risks" for what that gives up). All that's left is cleanup:

- **Clearing.** Step 8 calls `clearWriteAheadLog`, then persists `walCleared`. It deletes the plaintext WAL without creating it, and clears the sealed one. Don't use `retireLegacyStores`, which also deletes the plaintext Automerge database. This holds no lock, because an old tab can block the deletion until it times out. A failure is non-fatal: the flag stays unset, and the leader tries again at its next start.
- **`LocalEncryptionUpgrade`.** `copyWal` goes, since a copy would never be read. `hasWal` stays: without it, a plaintext WAL left behind would report `retired: true` while the database still exists, because `retireLegacyStores` deletes the Automerge database first and the WAL's deletion can then time out. `retired` caps the device's recorded level, so it must stay accurate.
- **The plaintext store.** No new code opens it. Opening it creates an empty database, which `hasLegacyLocalData` counts as legacy data.

### Deploying

- **Order:** `sst deploy` builds the site after the API, because the site needs the API's URL. For those few minutes old builds are refused with no new build to load. `handleClientOutdated` reloads at most once per 5 minutes and then shows its warning. Edits stay local.
- **Rollback:** there isn't a supported one. Old builds can't read the log, so anything since the cut would reach them only through snapshots. Test the release on a stage with real data, and fix forward.

### Afterwards

1. Leave `FlockSyncMessages` in place, unread and unwritten, in case a repair needs it. Its rows expire within 90 days, and then it can come out of `sst.config.ts`.
2. Remove the `sync.pollSync` stub once its traffic stops.
3. The first-start code stays until no device can still be on an old build. Remove it with a later `MIN_PROTOCOL_VERSION` bump only if every device has run it, since a device that skips it would trust old server heads.

### Docs (in the same release)

Update [sync-design.md](sync-design.md) and AGENTS.md:

- Rewrite "Incremental sync (WAL)" and "Pull filtering and cursors" as "Sync log".
- Add "Snapshot coverage" (S1–S3).
- Rules 2, 3 and 5–10 stay. Rule 1 says "the log" instead of "the WAL".
- Rule 4 gains "gap waits are never immediate pulls".
- In "Intentional designs", remove the settle window, the filtered per-item pulls, WAL pruning and the random cursor offsets. Keep "Pull queries are strictly `seq > after`".
- Replace `FlockSyncMessages` in the list of tables.
- In [local-encryption.md](local-encryption.md), add the new stores to the table, including that parked entries hold server ciphertext and need no seal.

## Tests

Unit specs go next to each component. Sync integration specs go in `packages/vault-client/src/worker/*.integration.spec.ts`, and the driver's in `packages/vault-server/src/drivers/dynamo/` against DynamoDB Local (port 8001).

| Scenario | Checks |
|---|---|
| Snapshot race (problem 1) | Two devices edit one item concurrently and the later snapshot wins. After S2 runs, the server snapshot has both changes. A third device that hydrates only from snapshots, with the log emptied, sees both. The S3 backstop alone (S2 disabled) also heals it. |
| Author never returns | A device pulls a change whose author goes away before uploading a snapshot. After a day, its manifest sync uploads the snapshot, and a new device gets the change with the log emptied. |
| Lost row (problem 2) | Delete one row. The client stops at the gap, waits, then skips it and runs a manifest sync. The next message for that item reports missing dependencies, and the snapshot is fetched in the same poll cycle. |
| Partial visibility | A fake driver returns `e+2` before `e+1`. The cursor stops at `e`, re-polls after 1 s, never 0 ms, and then applies both in order. |
| Parked entries survive a reload | A message arrives with missing dependencies, the worker restarts, the snapshot arrives, and the parked changes apply. |
| Missing key | Entries park and the cursor advances. A keyring update re-applies them. The item isn't quarantined before `MAX_PULL_RETRIES`. |
| Concurrent appends | Three devices push in parallel. The seqs are contiguous, nothing is lost and conflicts are retried. |
| Echo suppression | Applying pulled changes never marks an item pending. A pending item that pulls changes resends them at most once, and the devices that receive them mark nothing. |
| Follower and leader | A follower edits and the leader crashes before pushing. The new leader pushes from the persisted pending mark. |
| Split change sets | A change set over the limit goes out as several rows, and another device applies them in order. A push that fails partway resends the whole set with no harm. |
| Oversized change | A single change over the limit uploads a snapshot and writes no row. Another device gets it at its manifest sync, or at once when a later row depends on it. A snapshot over the item limit goes to `recreateOversizedItem`. |
| Catch-up | A device whose last pull was 28 days ago, and a new device whose log has lost its oldest rows to the TTL, each run a manifest sync before pulling and move past the stale gaps with no error. A fresh gap near the head still waits. |
| First start | With old server heads and an empty log: an unpushed edit is pushed, an item matching its snapshot pushes nothing and clears its mark, and a change only an old message delivered, which old server heads claim is synced, still reaches the log. The WAL stores end up empty or gone, and a failed clear retries at the next start. An interrupted local or network part repeats safely. A later tab never clears heads the leader has set. |
| First start offline | The local part finishes and releases the lock with no network, and a second tab starts at once. Edits mark items pending. The network part runs when the device comes online. |
| First-start items | Each row of step 5, including heads the doc lacks and malformed heads. A missing-key item never pushes its whole history, resolves after a keyring update and holds back no other item. An `awaitingSnapshot` item uploads despite S1, and its confirmation sets server heads. An item with no heads whose snapshot hasn't merged isn't uploaded. |
| Rewrites | `reencryptAllItems` with an unpushed change pushes first, then rewrites, quarantining nothing and reporting nothing in `failed`. A run started before the network part waits for it. A failed push retries without quarantine. An `awaitingHeads` item goes in `failed` without quarantine. A version jump on a rewrite records S2. |
| Plaintext WAL | A plaintext WAL left after a timed-out delete reports `retired: false` and retries. Nothing creates an empty plaintext WAL database, so `hasLegacyLocalData` stays false. |
| Plaintext session | With no cipher, first start and parking both work, and sealing later strands nothing. |
| Backup restore | An old backup with `pendingSync` still parses and restores. The field is ignored, and restored items are marked pending and dirty. |
| Two devices cross the cut | Each holds a change the other lacks and the server snapshot has neither, with and without snapshot heads. After both first starts, and a manifest sync on each in the no-heads case, both have both changes, and so does a new device. |
| Old build at the cut | `pollSync` and `putSnapshots` from protocol 4 return `CLIENT_OUTDATED`, not `NOT_FOUND`. A migrate tab reloads on it, and a rewrite that's refused quarantines nothing. |
| Incremental format | Concatenated `getChangesSince` output applies to a loaded doc, an unloaded doc and a doc with concurrent edits. Rows applied twice change nothing. An unloaded item with missing dependencies parks and stores no empty doc. |

Run `yarn test run`, `yarn typecheck` and `yarn lint` before each release.

## Risks and things to check first

- **DynamoDB transaction visibility.** The design assumes only that a consistent `Query` never shows uncommitted rows and that commits happen in seq order; contiguity covers partial visibility. Prove it with the "Partial visibility" and "Concurrent appends" specs against DynamoDB Local, and once against a real stage table.
- **Cost.** A transactional write costs twice the write units of a standard one. For this app's volume, that's cents.
- **Contention.** All of an account's appends serialise on the head row. Fine for one user's devices. A shared account would need a per-device sub-log, which isn't needed now.
- **Tabs open across the cut.** The `onClientOutdated` and `CLIENT_OUTDATED` fixes ship in the cut release, so they can't help a tab still running the old build. A migrate tab left open needs a manual reload, and a rewrite running at that moment can quarantine its batch. The window is small, and both fixes serve later `MIN_PROTOCOL_VERSION` bumps.
- **What the cut can lose.**
  - **Old messages.** A change is lost only if it's in no snapshot, it exists on the server only as an old message, and every device holding it never starts the new build. Until a holding device does start it, the other devices simply don't have the change yet.
  - **The WAL.** A change that only reached a device's WAL is dropped. The doc nearly always holds it, but not always: the Repo saves a doc and builds its sync message on separate 100 ms throttles, so a tab killed straight after an edit could leave a change only in the WAL, and so could a doc save that failed on full storage. This is the accepted cost of the hard cut, and a one-off exception to "never reset local data without the user confirming" (rule 10).
- **The shorter TTL.** After 30 days, a change that reached the log but no snapshot is gone from the server until a device that holds it uploads again. S3 does that within a day or so on any device that pulled it, so this needs the author and every such device to stay away.
- **First-start load.** Each device loads every doc once, decrypts every manifest head and may push many items. The first device also uploads a snapshot of most items, because few have heads yet. Run it on a stage copy of the largest account to measure this, and keep to `SYNC_BATCH_SIZES.hydrationConcurrency` and the poll chunk size.
- **Old tabs.** An old tab open during a first start can hold the plaintext WAL open, or write to either WAL afterwards. Neither matters to the data, because the WAL is never read: `clearWriteAheadLog` retries at the next start, and anything written after that sits unread until local data is cleared. Leadership doesn't change: the Web Lock keeps one leader, and an old leader's first refused write reloads it.
