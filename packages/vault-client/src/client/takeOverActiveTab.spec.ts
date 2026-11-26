import { takeOverActiveTab } from './takeOverActiveTab'
import { activeTabLockName } from '../shared/activeTab'
import { installFakeLocks, type FakeLockManager } from '../../test/fakeLocks'

describe('takeOverActiveTab', () => {
  const accountId = 'account-1'
  const lockName = activeTabLockName(accountId)
  let locks: FakeLockManager
  let restore: () => void

  beforeEach(() => {
    ({ locks, restore } = installFakeLocks())
  })

  afterEach(() => {
    restore()
  })

  /** Holds the lock as another tab's engine would, until `release` */
  function holdLock(options: LockOptions = {}) {
    const hold = Promise.withResolvers<void>()
    const request = locks.request(lockName, options, () => hold.promise)
    return { request, release: () => hold.resolve() }
  }

  it('displaces the tab holding the lock and returns once the lock is free', async () => {
    const holder = holdLock()
    const onStolen = vi.fn()

    await takeOverActiveTab(accountId, { onStolen })

    await expect(holder.request).rejects.toMatchObject({ name: 'AbortError' })
    expect(onStolen).toHaveBeenCalledTimes(1)
    expect(locks.isHeld(lockName)).toBe(false)
  })

  it('returns at once when no tab holds the lock', async () => {
    await takeOverActiveTab(accountId)

    expect(locks.isHeld(lockName)).toBe(false)
  })

  it('waits for a tab that was queued for the lock to let go of it', async () => {
    const holder = holdLock()
    // An older build's follower, queued for the lock, is granted it once the steal lets go
    const queued = holdLock()
    holder.request.catch(() => {})

    // The app asks older tabs to stop once the lock is stolen
    await takeOverActiveTab(accountId, { pollMs: 1, onStolen: () => setTimeout(queued.release, 20) })

    expect(locks.isHeld(lockName)).toBe(false)
  })

  it('gives up waiting after the timeout, leaving the engine to find the lock taken', async () => {
    const holder = holdLock()
    const queued = holdLock()
    holder.request.catch(() => {})

    await takeOverActiveTab(accountId, { timeoutMs: 20, pollMs: 1 })

    expect(locks.isHeld(lockName)).toBe(true)
    queued.release()
  })
})
