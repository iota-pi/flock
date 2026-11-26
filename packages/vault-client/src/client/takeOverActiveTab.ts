import { activeTabLockName, hasWebLocks } from '../shared/activeTab'
import { delay } from '../utils/abort'
import { createLogger } from '../utils/logger'

const log = createLogger('takeOverActiveTab')

export interface TakeOverOptions {
  /** How long to wait for the lock to come free after the steal */
  timeoutMs?: number
  pollMs?: number
  /**
   * Called once the lock has been stolen, before waiting for it to come free. Tabs of older builds
   * queue for the lock, so one may be granted it after the steal; this is where the app asks them to stop.
   */
  onStolen?: () => void
}

const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_POLL_MS = 50

/**
 * Makes this tab the account's active tab: steals the active-tab lock, which displaces the tab that
 * holds it (its engine stops), and waits until nothing holds it, so this tab's engine can take it.
 * A frozen holder has already lost the lock to the steal, so this doesn't wait for it to thaw.
 */
export async function takeOverActiveTab(accountId: string, options: TakeOverOptions = {}): Promise<void> {
  if (!hasWebLocks()) return
  const name = activeTabLockName(accountId)
  // Released as soon as it's granted: the steal only has to take the lock from its holder
  await navigator.locks.request(name, { steal: true }, async () => {})
  options.onStolen?.()
  if (typeof navigator.locks.query !== 'function') return

  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  for (;;) {
    const { held = [] } = await navigator.locks.query()
    if (!held.some(lock => lock.name === name)) return
    if (Date.now() >= deadline) {
      log.warn('The active-tab lock is still held after taking over')
      return
    }
    await delay(options.pollMs ?? DEFAULT_POLL_MS)
  }
}
