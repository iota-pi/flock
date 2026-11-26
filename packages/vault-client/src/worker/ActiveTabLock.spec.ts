import { ActiveTabLock } from './ActiveTabLock'
import { activeTabLockName, isActiveTabTakenError } from '../shared/activeTab'
import { installFakeLocks, type FakeLockManager } from '../../test/fakeLocks'

/** Lets every pending promise callback run */
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

describe('ActiveTabLock', () => {
  const accountId = 'account-1'
  const lockName = activeTabLockName(accountId)
  let locks: FakeLockManager
  let restore: () => void
  let onDisplaced: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    ({ locks, restore } = installFakeLocks())
    onDisplaced = vi.fn<() => void>()
  })

  afterEach(() => {
    restore()
  })

  it('holds the lock from acquire until release', async () => {
    const lock = new ActiveTabLock(accountId, { onDisplaced })

    await lock.acquire()
    expect(locks.isHeld(lockName)).toBe(true)

    lock.release()
    await flushPromises()
    expect(locks.isHeld(lockName)).toBe(false)
    expect(onDisplaced).not.toHaveBeenCalled()
  })

  it('fails rather than wait while another tab holds it', async () => {
    const other = new ActiveTabLock(accountId, { onDisplaced: vi.fn() })
    await other.acquire()

    const error = await new ActiveTabLock(accountId, { onDisplaced }).acquire().catch((e: unknown) => e)

    expect(isActiveTabTakenError(error)).toBe(true)
    expect(onDisplaced).not.toHaveBeenCalled()
  })

  it('reports being displaced once when another tab steals the lock', async () => {
    const lock = new ActiveTabLock(accountId, { onDisplaced })
    await lock.acquire()

    await locks.request(lockName, { steal: true }, async () => {})
    await flushPromises()

    expect(onDisplaced).toHaveBeenCalledTimes(1)
    // Releasing after being displaced must not release the lock another engine now holds
    const next = new ActiveTabLock(accountId, { onDisplaced: vi.fn() })
    await next.acquire()
    lock.release()
    await flushPromises()
    expect(locks.isHeld(lockName)).toBe(true)
  })

  it('does not report being displaced after it has released the lock', async () => {
    const lock = new ActiveTabLock(accountId, { onDisplaced })
    await lock.acquire()
    lock.release()

    await locks.request(lockName, { steal: true }, async () => {})
    await flushPromises()

    expect(onDisplaced).not.toHaveBeenCalled()
  })

  it('does nothing without Web Locks, since then every tab runs its engine', async () => {
    restore()
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true, writable: true })
    try {
      await expect(new ActiveTabLock(accountId, { onDisplaced }).acquire()).resolves.toBeUndefined()
    } finally {
      if (original) Object.defineProperty(navigator, 'locks', original)
      else delete (navigator as { locks?: LockManager }).locks
      ;({ locks, restore } = installFakeLocks())
    }
  })
})
