import { LeaderElection, type LeaderElectionCallbacks, type LeaderElectionOptions } from './LeaderElection'

const LOCK_NAME = 'test-vault-leader-acc-1'
const PRESENCE_CHANNEL = 'test-vault-leader-presence-acc-1'

function abortError(): DOMException {
  return new DOMException('The request was aborted.', 'AbortError')
}

interface LockEntry {
  name: string
  callback: (lock: { name: string }) => unknown
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

/**
 * The Web Locks a set of tabs share: one holder per name, queued requests granted in order, a
 * `signal` that drops a queued request, and `steal`, which rejects the holder's request with an
 * `AbortError` and grants at once.
 */
class FakeLockManager {
  private readonly held = new Map<string, LockEntry>()
  private readonly queue: LockEntry[] = []
  readonly requests: Array<{ name: string; options: LockOptions }> = []

  request = vi.fn((name: string, options: LockOptions, callback: LockEntry['callback']) => {
    this.requests.push({ name, options })
    return new Promise<unknown>((resolve, reject) => {
      const entry: LockEntry = { name, callback, resolve, reject }
      if (options.signal?.aborted) {
        reject(abortError())
        return
      }
      if (options.steal) {
        const holder = this.held.get(name)
        this.held.delete(name)
        holder?.reject(abortError())
        this.grant(entry)
        return
      }
      options.signal?.addEventListener('abort', () => {
        const index = this.queue.indexOf(entry)
        if (index === -1) return
        this.queue.splice(index, 1)
        reject(abortError())
      })
      this.queue.push(entry)
      this.grantNext(name)
    })
  })

  query = vi.fn(async () => ({
    held: Array.from(this.held.keys(), name => ({ name })),
    pending: this.queue.map(({ name }) => ({ name })),
  }))

  isHeld(name = LOCK_NAME): boolean {
    return this.held.has(name)
  }

  private grantNext(name: string): void {
    if (this.held.has(name)) return
    const index = this.queue.findIndex(entry => entry.name === name)
    if (index === -1) return
    const [entry] = this.queue.splice(index, 1)
    this.grant(entry)
  }

  private grant(entry: LockEntry): void {
    this.held.set(entry.name, entry)
    const settle = () => {
      if (this.held.get(entry.name) !== entry) return
      this.held.delete(entry.name)
      this.grantNext(entry.name)
    }
    Promise.resolve()
      .then(() => entry.callback({ name: entry.name }))
      .then(
        value => {
          settle()
          entry.resolve(value)
        },
        error => {
          settle()
          entry.reject(error)
        },
      )
  }
}

class MockBroadcastChannel {
  static readonly channels = new Set<MockBroadcastChannel>()
  onmessage: ((event: MessageEvent) => void) | null = null

  constructor(readonly name: string) {
    MockBroadcastChannel.channels.add(this)
  }

  postMessage(data: unknown): void {
    for (const channel of Array.from(MockBroadcastChannel.channels)) {
      if (channel !== this && channel.name === this.name) {
        channel.onmessage?.({ data } as MessageEvent)
      }
    }
  }

  close(): void {
    MockBroadcastChannel.channels.delete(this)
  }
}

function stubNavigator(value: object): void {
  Object.defineProperty(global, 'navigator', { value, writable: true, configurable: true })
}

/** Lets every pending promise callback run, for checking that something has not happened */
const flushPromises = () => new Promise(resolve => setTimeout(resolve, 0))

describe('LeaderElection', () => {
  let originalNavigator: Navigator
  let locks: FakeLockManager
  const elections: LeaderElection[] = []

  function createTab(options?: LeaderElectionOptions, accountId = 'acc-1') {
    const callbacks = {
      onLeaderGranted: vi.fn(),
      onLeaderRevoked: vi.fn(),
    } satisfies LeaderElectionCallbacks
    const election = new LeaderElection(accountId, callbacks, options)
    elections.push(election)
    return { election, ...callbacks }
  }

  /** A tab that has acquired the lock and leads */
  async function startLeader(options?: LeaderElectionOptions) {
    const tab = createTab(options)
    await tab.election.acquire()
    await vi.waitFor(() => expect(tab.election.leader).toBe(true))
    return tab
  }

  /** A tab queued behind the leader */
  async function startFollower(options?: LeaderElectionOptions) {
    const tab = createTab(options)
    await tab.election.acquire()
    await flushPromises()
    expect(tab.election.leader).toBe(false)
    return tab
  }

  beforeEach(() => {
    originalNavigator = global.navigator
    locks = new FakeLockManager()
    stubNavigator({ locks })
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    MockBroadcastChannel.channels.clear()
  })

  afterEach(() => {
    for (const election of elections.splice(0)) {
      election.release()
    }
    stubNavigator(originalNavigator)
    MockBroadcastChannel.channels.clear()
    vi.unstubAllGlobals()
  })

  it('leads in every tab when navigator.locks is undefined', async () => {
    stubNavigator({})
    const a = createTab()
    const b = createTab()

    await a.election.acquire()
    await b.election.acquire()

    expect(a.election.leader).toBe(true)
    expect(b.election.leader).toBe(true)
    expect(await b.election.claimLeadership()).toBe(true)
    expect(a.onLeaderGranted).toHaveBeenCalledTimes(1)
  })

  it('grants the lock to the first tab and queues the next behind it', async () => {
    const a = await startLeader()
    const b = await startFollower()

    expect(a.onLeaderGranted).toHaveBeenCalledTimes(1)
    expect(b.onLeaderGranted).not.toHaveBeenCalled()

    a.election.release()

    expect(a.onLeaderRevoked).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(b.election.leader).toBe(true))
  })

  describe('isLockHeldElsewhere', () => {
    it('says so while another tab holds the lock', async () => {
      await startLeader()
      const b = await startFollower()

      expect(await b.election.isLockHeldElsewhere()).toBe(true)
    })

    it("ignores other accounts' locks", async () => {
      await startLeader()
      const other = createTab(undefined, 'acc-2')
      await other.election.acquire()

      expect(await other.election.isLockHeldElsewhere()).toBe(false)
    })

    it('says no once this tab leads', async () => {
      const a = await startLeader()

      expect(await a.election.isLockHeldElsewhere()).toBe(false)
    })
  })

  describe('claimLeadership', () => {
    it('steals the lock, and the tab that held it stops leading and queues again', async () => {
      const a = await startLeader()
      const b = await startFollower()

      expect(await b.election.claimLeadership()).toBe(true)

      expect(b.election.leader).toBe(true)
      expect(locks.requests.at(-2)?.options).toEqual({ steal: true })
      await vi.waitFor(() => expect(a.election.leader).toBe(false))
      expect(a.onLeaderRevoked).toHaveBeenCalledTimes(1)

      b.election.release()
      await vi.waitFor(() => expect(a.election.leader).toBe(true))
      expect(a.onLeaderGranted).toHaveBeenCalledTimes(2)
    })

    it('drops its own queued request, so it holds the lock once', async () => {
      await startLeader()
      const b = await startFollower()

      await b.election.claimLeadership()
      b.election.release()
      await flushPromises()

      // The leader's re-queued request has the lock, and nothing of B's is left to be granted it
      expect(b.onLeaderGranted).toHaveBeenCalledTimes(1)
      expect(locks.isHeld()).toBe(true)
    })

    it('hands leadership back and forth', async () => {
      const a = await startLeader()
      const b = await startFollower()

      await b.election.claimLeadership()
      await vi.waitFor(() => expect(a.election.leader).toBe(false))
      await a.election.claimLeadership()
      await vi.waitFor(() => expect(b.election.leader).toBe(false))

      expect(a.election.leader).toBe(true)
      expect(a.onLeaderGranted).toHaveBeenCalledTimes(2)
      expect(b.onLeaderRevoked).toHaveBeenCalledTimes(1)
    })

    it('shares one steal between concurrent claims', async () => {
      await startLeader()
      const b = await startFollower()

      const results = await Promise.all([b.election.claimLeadership(), b.election.claimLeadership()])

      expect(results).toEqual([true, true])
      expect(locks.requests.filter(({ options }) => options.steal)).toHaveLength(1)
    })

    it('resolves at once in the leader, without stealing', async () => {
      const a = await startLeader()

      expect(await a.election.claimLeadership()).toBe(true)
      expect(locks.requests.filter(({ options }) => options.steal)).toHaveLength(0)
    })

    it('does nothing once released', async () => {
      const a = createTab()

      expect(await a.election.claimLeadership()).toBe(false)
      expect(locks.request).not.toHaveBeenCalled()
    })

    it('gives the lock straight back if released while the steal is in flight', async () => {
      const a = await startLeader()
      const b = await startFollower()

      const claim = b.election.claimLeadership()
      b.election.release()

      expect(await claim).toBe(false)
      expect(b.onLeaderGranted).not.toHaveBeenCalled()
      await vi.waitFor(() => expect(a.election.leader).toBe(true))
    })
  })

  describe('lock errors', () => {
    it('retries after a failed request without leading in between', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      locks.request.mockImplementationOnce(() => Promise.reject(new Error('Transient')))
      const a = createTab({ retryDelayMs: 10 })

      await a.election.acquire()
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('[LeaderElection] Failed to acquire lock (attempt 1/3)'),
        expect.any(Error),
      ))
      expect(a.election.leader).toBe(false)

      await vi.waitFor(() => expect(a.election.leader).toBe(true))
      expect(locks.request).toHaveBeenCalledTimes(2)
    })

    it('leads without the lock once every retry has failed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      locks.request.mockImplementation(() => Promise.reject(new Error('Permanent')))
      const a = createTab({ retryDelayMs: 5 })

      await a.election.acquire()

      await vi.waitFor(() => expect(a.election.leader).toBe(true))
      expect(locks.request).toHaveBeenCalledTimes(3)
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringContaining('[LeaderElection] Web Locks permanently failed after 3 attempts'),
        expect.any(Error),
      )
    })

    it('stops leading if its held lock fails, then queues again', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let fail!: (error: Error) => void
      locks.request.mockImplementationOnce((name, _options, callback) => {
        void callback({ name })
        return new Promise((_, reject) => {
          fail = reject
        })
      })
      const a = createTab({ retryDelayMs: 10 })
      await a.election.acquire()
      expect(a.election.leader).toBe(true)

      fail(new Error('Lock lost'))

      await vi.waitFor(() => expect(a.onLeaderRevoked).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(a.election.leader).toBe(true))
      expect(locks.request).toHaveBeenCalledTimes(2)
    })
  })

  describe('claims for tabs of the previous release', () => {
    function listen() {
      const messages: unknown[] = []
      const channel = new MockBroadcastChannel(PRESENCE_CHANNEL)
      channel.onmessage = event => messages.push(event.data)
      return messages
    }

    it('claims on the presence channel while it leads, and releases when it stops', async () => {
      const messages = listen()
      const a = await startLeader({ legacyClaimIntervalMs: 10 })

      expect(messages).toEqual([expect.objectContaining({ type: 'claim', isFallback: false })])
      await vi.waitFor(() => expect(messages.length).toBeGreaterThanOrEqual(3))

      a.election.release()
      expect(messages.at(-1)).toEqual({ type: 'release', leaderId: expect.any(String) })
      const count = messages.length
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(messages).toHaveLength(count)
    })

    it('stops claiming when another tab steals the lock', async () => {
      const messages = listen()
      const a = await startLeader({ legacyClaimIntervalMs: 1000 })
      const b = await startFollower({ legacyClaimIntervalMs: 1000 })

      await b.election.claimLeadership()
      await vi.waitFor(() => expect(a.election.leader).toBe(false))

      const types = messages.map(message => (message as { type: string; leaderId: string }))
      const leaderA = types[0].leaderId
      expect(types.filter(message => message.leaderId === leaderA).map(message => message.type)).toEqual(['claim', 'release'])
      expect(types.filter(message => message.leaderId !== leaderA).map(message => message.type)).toEqual(['claim'])
    })
  })
})
