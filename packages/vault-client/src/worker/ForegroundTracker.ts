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
  /** Whether this tab leads, which it tells the other tabs */
  isLeader?: () => boolean
  /**
   * The user came back to this tab, which doesn't lead, while the leader's tab is hidden: it was
   * already, or it reported so within `leaderHandoffWindow`
   */
  onLeaderAway?: () => void
}

interface Peer {
  lastSeen: number
  leader: boolean
}

/**
 * Tracks whether any of the account's tabs on this device is visible, so the leader polls at the
 * foreground rate while someone is looking, even when the leader's own tab is hidden. Every tab runs
 * one: a visible tab tells the others when it changes and every `foregroundPingInterval` after that.
 * It also tracks recent activity, which a visible tab reports with its visibility, so the leader
 * polls at the active rate while the user is using any of the tabs. Each tab also says whether it
 * leads, so a tab the user comes back to can tell whether the leader's tab is hidden.
 */
export class ForegroundTracker {
  private readonly tabId = crypto.randomUUID()
  private visible: boolean
  /** The other visible tabs, with when each last reported and whether it leads */
  private readonly visiblePeers = new Map<string, Peer>()
  private lastActivityAt = -Infinity
  /** When the user last came back to this tab */
  private returnedAt = -Infinity
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
    if (visible && returned) {
      this.returnedAt = Date.now()
      this.checkLeaderAway()
    }
  }

  /** Tells the other tabs that this tab's leadership changed, if it's visible */
  onLeaderChange(): void {
    if (this.unsubscribe && this.visible) {
      this.publish(false)
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
    this.returnedAt = -Infinity
  }

  private handlePeer({ tabId, visible, returned, active, leader = false }: TabVisibility): void {
    if (!visible) {
      this.visiblePeers.delete(tabId)
      if (leader) {
        this.checkLeaderAway()
      }
      return
    }
    this.pruneStalePeers()
    const isNew = !this.visiblePeers.has(tabId)
    this.visiblePeers.set(tabId, { lastSeen: Date.now(), leader })
    if (returned || isNew) {
      this.deps.onPeerReturned()
    }
    // A new tab would otherwise not know this one is visible, or leads, until its next ping
    if (isNew && this.visible) {
      this.publish(false)
    }
    if (active) {
      this.noteActivity()
    }
  }

  /** Reports the leader away if the user just came back to this tab and no visible tab leads */
  private checkLeaderAway(): void {
    if (!this.visible || this.deps.isLeader?.()) return
    if (Date.now() - this.returnedAt > SYNC_TIMEOUTS.leaderHandoffWindow) return
    this.pruneStalePeers()
    for (const peer of this.visiblePeers.values()) {
      if (peer.leader) return
    }
    this.deps.onLeaderAway?.()
  }

  private publish(returned: boolean, active = false): void {
    this.deps.bus.publishTabVisibility({
      tabId: this.tabId,
      visible: this.visible,
      returned,
      active,
      leader: this.deps.isLeader?.() ?? false,
    })
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
    for (const [tabId, { lastSeen }] of this.visiblePeers) {
      if (now - lastSeen > PEER_TIMEOUT_MS) {
        this.visiblePeers.delete(tabId)
      }
    }
  }
}
