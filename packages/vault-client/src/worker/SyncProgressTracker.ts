import type { ClientEvent, ClientEventHub } from './SyncEventHub'
import type { PollOutcome } from './SyncPoller'
import type { LastSyncedStore } from './stores/LastSyncedStore'
import type { SyncProgress, UnsyncedChanges } from '../shared/types'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'
import { SingleFlightGuard } from '../utils/SingleFlightGuard'
import { fireAndForget } from '../utils/fireAndForget'
import { createLogger } from '../utils/logger'

const log = createLogger('SyncProgressTracker')

/** Events after which the changes waiting to sync may have changed */
const RECOUNT_EVENTS = new Set<ClientEvent['type']>([
  'itemUpdated',
  'finishRequest',
  'recoveryItemsChanged',
  'snapshotFailed',
  'statusChange',
])

export interface SyncProgressTrackerDeps {
  eventHub: ClientEventHub
  store: LastSyncedStore
  /** Counts what hasn't reached the server, without pushing anything first */
  countUnpushedChanges: () => Promise<UnsyncedChanges>
  now?: () => number
}

/**
 * Tells the app how many items have changes the server doesn't have yet and when this device last
 * synced, emitting `syncProgress` whenever either changes. It recounts shortly after anything that may
 * have changed the counts, and every so often anyway: pending marks, the recovery store and the last sync
 * time are shared by the account's tabs, so this is how a tab that isn't the leader sees its pushes.
 */
export class SyncProgressTracker {
  private lastSyncedAt: number | null = null
  private emitted: SyncProgress | null = null
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private intervalTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly recountGuard = new SingleFlightGuard<void>()
  private recountAgain = false
  private stopped = false

  constructor(private readonly deps: SyncProgressTrackerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  async start(): Promise<void> {
    this.lastSyncedAt = await this.deps.store.load()
    this.unsubscribe = this.deps.eventHub.subscribe(event => {
      if (RECOUNT_EVENTS.has(event.type)) this.scheduleRecount()
    })
    this.intervalTimer = setInterval(() => this.scheduleRecount(), SYNC_TIMEOUTS.syncProgressInterval)
    this.scheduleRecount()
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = null
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.intervalTimer = null
  }

  /** Called with every poll's outcome. A successful poll pushed pending changes and pulled from the server. */
  onPollResult(outcome: PollOutcome): void {
    if (outcome === 'success') {
      const now = this.now()
      this.lastSyncedAt = now
      fireAndForget(this.deps.store.save(now), 'SyncProgressTracker:saveLastSyncedAt')
    }
    this.scheduleRecount()
  }

  scheduleRecount(): void {
    if (this.stopped || this.debounceTimer) return
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      fireAndForget(this.recount(), 'SyncProgressTracker:recount')
    }, SYNC_TIMEOUTS.syncProgressDebounce)
  }

  /** Recounts and emits the progress if it changed. A recount asked for while one runs runs after it. */
  async recount(): Promise<void> {
    if (this.recountGuard.isRunning) {
      this.recountAgain = true
      return this.recountGuard.waitForRunning()
    }
    await this.recountGuard.run(async () => {
      do {
        this.recountAgain = false
        await this.emitProgress()
      } while (this.recountAgain && !this.stopped)
    })
  }

  private async emitProgress(): Promise<void> {
    let changes: UnsyncedChanges
    let stored: number | null
    try {
      [changes, stored] = await Promise.all([this.deps.countUnpushedChanges(), this.deps.store.load()])
    } catch (error) {
      log.warn('Could not count the changes waiting to sync', error)
      return
    }
    if (this.stopped) return

    // Another tab may have synced since
    if (stored !== null && (this.lastSyncedAt === null || stored > this.lastSyncedAt)) {
      this.lastSyncedAt = stored
    }
    const progress: SyncProgress = { ...changes, lastSyncedAt: this.lastSyncedAt }
    const previous = this.emitted
    if (
      previous
      && previous.pendingItems === progress.pendingItems
      && previous.quarantinedItems === progress.quarantinedItems
      && previous.lastSyncedAt === progress.lastSyncedAt
    ) {
      return
    }
    this.emitted = progress
    this.deps.eventHub.emit({ type: 'syncProgress', progress })
  }
}
