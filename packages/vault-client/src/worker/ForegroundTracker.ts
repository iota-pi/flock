import type { RealtimeBus, TabVisibility } from './RealtimeBus'
import { SYNC_TIMEOUTS } from '../shared/syncConfig'

/** A tab that stops reporting it's visible (it crashed or was frozen) counts as hidden after this long */
const PEER_TIMEOUT_MS = SYNC_TIMEOUTS.foregroundPingInterval * 2.5

export interface ForegroundTrackerDeps {
  bus: Pick<RealtimeBus, 'publishTabVisibility' | 'subscribeTabVisibility'>
  /** Whether this tab is visible when the session starts */
  isVisible: boolean
  /** Another tab of the account came into view, or one we didn't know was visible reported in */
  onPeerReturned: () => void
  /** Activity was recorded: input in this tab or another visible one, or changes from another device */
  onActivity?: () => void
}

/**
 * Tracks whether any of the account's tabs on this device is visible, so the leader polls at the
 * foreground rate while someone is looking, even when the leader's own tab is hidden. Every tab runs
 * one: a visible tab tells the others when it changes and every `foregroundPingInterval` after that.
 * It also tracks recent activity, which a visible tab reports with its visibility, so the leader
 * polls at the active rate while the user is using any of the tabs.
 */
export class ForegroundTracker {
  private readonly tabId = crypto.randomUUID()
  private visible: boolean
  /** The other visible tabs, with when each last reported */
  private readonly visiblePeers = new Map<string, number>()
  private lastActivityAt = -Infinity
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly deps: ForegroundTrackerDeps) {
    this.visible = deps.isVisible
  }

  /** Whether this tab or another of the account's tabs is visible */
  get isAnyVisible(): boolean {
    if (this.visible) return true
    this.pruneStalePeers()
    return this.visiblePeers.size > 0
  }

  /** Whether a tab is visible and there was activity in the last `activityWindow` */
  get isActive(): boolean {
    return this.isAnyVisible && Date.now() - this.lastActivityAt < SYNC_TIMEOUTS.activityWindow
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = this.deps.bus.subscribeTabVisibility(visibility => this.handlePeer(visibility))
    if (this.visible) {
      this.publish(true)
      this.startPinging()
    }
  }

  /** Records this tab's visibility. `returned` says the user just came back to it. */
  setVisible(visible: boolean, returned = false): void {
    const changed = this.visible !== visible
    this.visible = visible
    if (!this.unsubscribe) return
    if (changed || returned) {
      this.publish(returned)
    }
    if (visible) {
      this.startPinging()
    } else {
      this.stopPinging()
    }
  }

  /** Records that the user is using this tab, and tells the account's other tabs if it's visible */
  recordActivity(): void {
    this.noteActivity()
    if (this.unsubscribe && this.visible) {
      this.publish(false, true)
    }
  }

  /** Records activity this tab alone needs to know of, such as changes pulled from another device */
  noteActivity(): void {
    this.lastActivityAt = Date.now()
    this.deps.onActivity?.()
  }

  stop(): void {
    if (!this.unsubscribe) return
    this.stopPinging()
    if (this.visible) {
      this.deps.bus.publishTabVisibility({ tabId: this.tabId, visible: false, returned: false })
    }
    this.unsubscribe()
    this.unsubscribe = null
    this.visiblePeers.clear()
    this.lastActivityAt = -Infinity
  }

  private handlePeer({ tabId, visible, returned, active }: TabVisibility): void {
    if (!visible) {
      this.visiblePeers.delete(tabId)
      return
    }
    this.pruneStalePeers()
    const isNew = !this.visiblePeers.has(tabId)
    this.visiblePeers.set(tabId, Date.now())
    if (returned || isNew) {
      this.deps.onPeerReturned()
    }
    if (active) {
      this.noteActivity()
    }
  }

  private publish(returned: boolean, active = false): void {
    this.deps.bus.publishTabVisibility({ tabId: this.tabId, visible: this.visible, returned, active })
  }

  private startPinging(): void {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => this.publish(false), SYNC_TIMEOUTS.foregroundPingInterval)
  }

  private stopPinging(): void {
    if (!this.pingTimer) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private pruneStalePeers(): void {
    const now = Date.now()
    for (const [tabId, lastSeen] of this.visiblePeers) {
      if (now - lastSeen > PEER_TIMEOUT_MS) {
        this.visiblePeers.delete(tabId)
      }
    }
  }
}
