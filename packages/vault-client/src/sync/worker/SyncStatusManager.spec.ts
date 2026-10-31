import { SyncStatusManager } from './SyncStatusManager'
import { ClientEventHub } from './SyncEventHub'
import { SyncSessionState } from './SyncSessionState'

describe('SyncStatusManager', () => {
  let clientEventHub: ClientEventHub
  let statusManager: SyncStatusManager
  let session: SyncSessionState

  /** Changes the session's online state and tells the manager, as the worker does */
  function setOnline(isOnline: boolean): void {
    session.setOnline(isOnline)
    statusManager.onOnlineStateChange()
  }
  let emittedStatuses: string[]

  beforeEach(() => {
    clientEventHub = new ClientEventHub()
    emittedStatuses = []
    clientEventHub.subscribe(event => {
      if (event.type === 'statusChange') {
        emittedStatuses.push(event.status)
      }
    })
    session = new SyncSessionState()
    statusManager = new SyncStatusManager(clientEventHub, session)
  })

  it('initializes with offline status and resets cleanly', () => {
    expect(statusManager.getStatus()).toBe('offline')

    statusManager.reset()
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['idle'])

    session.setOnline(false)

    statusManager.reset()
    expect(statusManager.getStatus()).toBe('offline')
    expect(emittedStatuses).toEqual(['idle', 'offline'])
  })

  it('handles online and offline transitions', () => {
    statusManager.reset()
    emittedStatuses = []

    setOnline(false)
    expect(statusManager.getStatus()).toBe('offline')
    expect(emittedStatuses).toEqual(['offline'])

    setOnline(true)
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['offline', 'idle'])
  })

  it('tracks in-flight requests and sets status to syncing', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.startRequest()
    expect(statusManager.getStatus()).toBe('syncing')
    expect(emittedStatuses).toEqual(['syncing'])

    statusManager.startRequest()
    expect(statusManager.getStatus()).toBe('syncing')
    expect(emittedStatuses).toEqual(['syncing']) // No duplicate emission

    statusManager.finishRequest()
    expect(statusManager.getStatus()).toBe('syncing')

    statusManager.finishRequest()
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['syncing', 'idle'])
  })

  it('preserves activeRequests across reset() so in-flight requests do not desynchronize', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.startRequest()
    expect(statusManager.getStatus()).toBe('syncing')
    expect(emittedStatuses).toEqual(['syncing'])

    // When reset() is called with in-flight requests outstanding:
    statusManager.reset()
    // activeRequests is preserved and status remains syncing
    expect(statusManager.getStatus()).toBe('syncing')
    // No spurious status change emitted
    expect(emittedStatuses).toEqual(['syncing'])

    // A second request starts (e.g. after reconnect)
    statusManager.startRequest()
    expect(statusManager.getStatus()).toBe('syncing')

    // The first in-flight request completes
    statusManager.finishRequest()
    // Should NOT transition to idle because second request is still in flight
    expect(statusManager.getStatus()).toBe('syncing')
    expect(emittedStatuses).toEqual(['syncing'])

    // The second request completes
    statusManager.finishRequest()
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['syncing', 'idle'])
  })

  it('preserves activeRequests across reset() while offline and resumes syncing upon reconnecting', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.startRequest()
    expect(statusManager.getStatus()).toBe('syncing')

    // Reset with offline state
    session.setOnline(false)
    statusManager.reset()
    expect(statusManager.getStatus()).toBe('offline')

    // Reconnecting while request is still pending restores syncing status
    setOnline(true)
    expect(statusManager.getStatus()).toBe('syncing')

    // Request completes
    statusManager.finishRequest()
    expect(statusManager.getStatus()).toBe('idle')
  })

  it('transitions to degraded on poll failure and recovers on success', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.handlePollResult('failure')
    expect(statusManager.getStatus()).toBe('degraded')
    expect(emittedStatuses).toEqual(['degraded'])

    // When a request starts during degraded state, it shows syncing
    statusManager.startRequest()
    expect(statusManager.getStatus()).toBe('syncing')
    expect(emittedStatuses).toEqual(['degraded', 'syncing'])

    // When request finishes, it returns to degraded because last poll was a failure
    statusManager.finishRequest()
    expect(statusManager.getStatus()).toBe('degraded')
    expect(emittedStatuses).toEqual(['degraded', 'syncing', 'degraded'])

    // On poll success, it recovers to idle
    statusManager.handlePollResult('success')
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['degraded', 'syncing', 'degraded', 'idle'])
  })

  it('transitions to degraded on quota exceeded', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.setQuotaExceeded(true)
    expect(statusManager.getStatus()).toBe('degraded')
    expect(emittedStatuses).toEqual(['degraded'])

    statusManager.setQuotaExceeded(false)
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['degraded', 'idle'])
  })

  it('transitions to degraded on pull retry state active', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.setDegradedPull(true)
    expect(statusManager.getStatus()).toBe('degraded')
    expect(emittedStatuses).toEqual(['degraded'])

    statusManager.setDegradedPull(false)
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['degraded', 'idle'])
  })

  it('transitions to offline on auth-failure outcome', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.handlePollResult('auth-failure')
    expect(statusManager.getStatus()).toBe('offline')
    expect(emittedStatuses).toEqual(['offline'])

    statusManager.handlePollResult('success')
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['offline', 'idle'])
  })

  it('ignores no-poll outcomes', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.handlePollResult('no-poll')
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual([])
  })

  it('is degraded after a snapshot failure until the next successful poll', () => {
    statusManager.reset()
    emittedStatuses = []

    statusManager.setSnapshotFailed()
    expect(statusManager.getStatus()).toBe('degraded')

    statusManager.handlePollResult('success')
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['degraded', 'idle'])
  })
})
