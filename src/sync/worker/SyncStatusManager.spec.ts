import { SyncStatusManager } from './SyncStatusManager'
import { ClientEventHub } from './SyncEventHub'

describe('SyncStatusManager', () => {
  let clientEventHub: ClientEventHub
  let statusManager: SyncStatusManager
  let emittedStatuses: string[]

  beforeEach(() => {
    clientEventHub = new ClientEventHub()
    emittedStatuses = []
    clientEventHub.subscribe(event => {
      if (event.type === 'statusChange') {
        emittedStatuses.push(event.status)
      }
    })
    statusManager = new SyncStatusManager(clientEventHub)
  })

  it('initializes with offline status and resets cleanly', () => {
    expect(statusManager.getStatus()).toBe('offline')

    statusManager.reset(true)
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['idle'])

    statusManager.reset(false)
    expect(statusManager.getStatus()).toBe('offline')
    expect(emittedStatuses).toEqual(['idle', 'offline'])
  })

  it('handles online and offline transitions', () => {
    statusManager.reset(true)
    emittedStatuses = []

    statusManager.setOnlineState(false)
    expect(statusManager.getStatus()).toBe('offline')
    expect(emittedStatuses).toEqual(['offline'])

    statusManager.setOnlineState(true)
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['offline', 'idle'])
  })

  it('tracks in-flight requests and sets status to syncing', () => {
    statusManager.reset(true)
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

  it('transitions to degraded on poll failure and recovers on success', () => {
    statusManager.reset(true)
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

  it('transitions to offline on auth-failure outcome', () => {
    statusManager.reset(true)
    emittedStatuses = []

    statusManager.handlePollResult('auth-failure')
    expect(statusManager.getStatus()).toBe('offline')
    expect(emittedStatuses).toEqual(['offline'])

    statusManager.handlePollResult('success')
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual(['offline', 'idle'])
  })

  it('ignores no-poll outcomes', () => {
    statusManager.reset(true)
    emittedStatuses = []

    statusManager.handlePollResult('no-poll')
    expect(statusManager.getStatus()).toBe('idle')
    expect(emittedStatuses).toEqual([])
  })
})
