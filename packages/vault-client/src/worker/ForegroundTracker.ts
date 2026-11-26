import { SYNC_TIMEOUTS } from '../shared/syncConfig'

export interface ForegroundTrackerDeps {
  /** Whether the tab is visible when the session starts */
  isVisible: boolean
  /** Activity was recorded: input in the tab, or changes from another device */
  onActivity?: () => void
}

/**
 * Tracks whether the tab is visible and whether it's in use, which set how often the session polls:
 * at the active rate while the user is using the visible tab or changes just came from another
 * device, and at the hidden rate while the tab is hidden.
 */
export class ForegroundTracker {
  private visible: boolean
  private lastActivityAt = -Infinity

  constructor(private readonly deps: ForegroundTrackerDeps) {
    this.visible = deps.isVisible
  }

  /** Whether the tab is visible */
  get isVisible(): boolean {
    return this.visible
  }

  /** Whether the tab is visible and there was activity in the last `activityWindow` */
  get isActive(): boolean {
    return this.visible && Date.now() - this.lastActivityAt < SYNC_TIMEOUTS.activityWindow
  }

  /** Records the tab's visibility */
  setVisible(visible: boolean): void {
    this.visible = visible
  }

  /** Records activity: the user's input, or changes pulled from another device */
  noteActivity(): void {
    this.lastActivityAt = Date.now()
    this.deps.onActivity?.()
  }
}
