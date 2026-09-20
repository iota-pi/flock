import { ItemId } from 'src/shared/schemas/items'

// Create the mock BroadcastChannel class
class MockBroadcastChannel {
  name: string
  onmessage: ((ev: MessageEvent) => any) | null = null
  onmessageerror: ((ev: MessageEvent) => any) | null = null
  postMessage = vi.fn()
  close = vi.fn()

  static instances: MockBroadcastChannel[] = []

  constructor(name: string) {
    this.name = name
    MockBroadcastChannel.instances.push(this)
  }
}

// Stub global BroadcastChannel before importing the module
vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)

describe('realtimeBus', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    MockBroadcastChannel.instances = []
    vi.clearAllMocks()
  })

  it('initializes the BroadcastChannel scoped by account ID on subscription and registers listeners', async () => {
    const { subscribeRealtimeBusSyncPing, getSyncPingChannelName } = await import('./realtimeBus')
    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing('acc-1', listener)

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    const channel = MockBroadcastChannel.instances[0]
    expect(channel.name).toBe(getSyncPingChannelName('acc-1'))
    expect(channel.name).toBe('flock-sync-ping-bus-acc-1')

    // Simulate receiving a message on the channel
    const event = {
      data: {
        type: 'sync_ping',
        itemIds: ['item-a', 'item-b'],
      },
    } as MessageEvent

    if (channel.onmessage) {
      channel.onmessage(event)
    }

    expect(listener).toHaveBeenCalledWith(['item-a', 'item-b'])

    unsubscribe()
  })

  it('isolates pings across different accounts', async () => {
    const { subscribeRealtimeBusSyncPing, publishRealtimeBusSyncPing } = await import('./realtimeBus')
    const listenerAcc1 = vi.fn()
    const listenerAcc2 = vi.fn()

    const unsub1 = subscribeRealtimeBusSyncPing('acc-1', listenerAcc1)
    const unsub2 = subscribeRealtimeBusSyncPing('acc-2', listenerAcc2)

    expect(MockBroadcastChannel.instances).toHaveLength(2)
    const channel1 = MockBroadcastChannel.instances.find(c => c.name === 'flock-sync-ping-bus-acc-1')!
    const channel2 = MockBroadcastChannel.instances.find(c => c.name === 'flock-sync-ping-bus-acc-2')!
    expect(channel1).toBeDefined()
    expect(channel2).toBeDefined()

    // Publish to acc-1
    publishRealtimeBusSyncPing('acc-1', ['item-1'] as ItemId[])
    expect(channel1.postMessage).toHaveBeenCalledWith({
      type: 'sync_ping',
      itemIds: ['item-1'],
    })
    expect(channel2.postMessage).not.toHaveBeenCalled()

    // Simulate incoming message on channel1
    channel1.onmessage?.({
      data: { type: 'sync_ping', itemIds: ['item-1'] },
    } as MessageEvent)

    expect(listenerAcc1).toHaveBeenCalledWith(['item-1'])
    expect(listenerAcc2).not.toHaveBeenCalled()

    unsub1()
    unsub2()
  })

  it('does not notify unsubscribed listeners', async () => {
    const { subscribeRealtimeBusSyncPing } = await import('./realtimeBus')
    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing('acc-1', listener)
    unsubscribe()

    const channel = MockBroadcastChannel.instances[0]
    const event = {
      data: {
        type: 'sync_ping',
        itemIds: ['item-a'],
      },
    } as MessageEvent

    if (channel && channel.onmessage) {
      channel.onmessage(event)
    }

    expect(listener).not.toHaveBeenCalled()
  })

  it('publishes messages through a single long-lived BroadcastChannel per account without closing it', async () => {
    const { publishRealtimeBusSyncPing } = await import('./realtimeBus')
    publishRealtimeBusSyncPing('acc-1', ['item-1', 'item-2'] as ItemId[])

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    const channel = MockBroadcastChannel.instances[0]
    expect(channel.name).toBe('flock-sync-ping-bus-acc-1')
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'sync_ping',
      itemIds: ['item-1', 'item-2'],
    })
    expect(channel.close).not.toHaveBeenCalled()

    publishRealtimeBusSyncPing('acc-1', ['item-3'] as ItemId[])
    expect(MockBroadcastChannel.instances).toHaveLength(1)
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'sync_ping',
      itemIds: ['item-3'],
    })
    expect(channel.close).not.toHaveBeenCalled()
  })

  it('reuses the same BroadcastChannel across subscribers and publishers without closing on unsubscribe', async () => {
    const { subscribeRealtimeBusSyncPing, publishRealtimeBusSyncPing } = await import('./realtimeBus')
    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing('acc-1', listener)

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    const channel = MockBroadcastChannel.instances[0]

    publishRealtimeBusSyncPing('acc-1', ['item-1'] as ItemId[])
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'sync_ping',
      itemIds: ['item-1'],
    })
    expect(channel.close).not.toHaveBeenCalled()

    unsubscribe()
    expect(channel.close).not.toHaveBeenCalled()
    expect(MockBroadcastChannel.instances).toHaveLength(1)
  })

  it('teardownRealtimeBus(accountId) closes the channel and cleans up listeners for the specific account', async () => {
    const { subscribeRealtimeBusSyncPing, teardownRealtimeBus } = await import('./realtimeBus')
    const listener1 = vi.fn()
    const listener2 = vi.fn()

    subscribeRealtimeBusSyncPing('acc-1', listener1)
    subscribeRealtimeBusSyncPing('acc-2', listener2)

    const channel1 = MockBroadcastChannel.instances.find(c => c.name === 'flock-sync-ping-bus-acc-1')!
    const channel2 = MockBroadcastChannel.instances.find(c => c.name === 'flock-sync-ping-bus-acc-2')!

    teardownRealtimeBus('acc-1')

    expect(channel1.close).toHaveBeenCalledTimes(1)
    expect(channel2.close).not.toHaveBeenCalled()

    // Message sent to channel1 should no longer trigger listener1
    channel1.onmessage?.({
      data: { type: 'sync_ping', itemIds: ['item-x'] },
    } as MessageEvent)
    expect(listener1).not.toHaveBeenCalled()
  })

  it('teardownRealtimeBus() without arguments closes all channels across all accounts', async () => {
    const { subscribeRealtimeBusSyncPing, teardownRealtimeBus } = await import('./realtimeBus')
    subscribeRealtimeBusSyncPing('acc-1', vi.fn())
    subscribeRealtimeBusSyncPing('acc-2', vi.fn())

    expect(MockBroadcastChannel.instances).toHaveLength(2)

    teardownRealtimeBus()

    for (const channel of MockBroadcastChannel.instances) {
      expect(channel.close).toHaveBeenCalledTimes(1)
    }
  })

  it('re-initializes a new channel if subscribed or published to after teardown', async () => {
    const { subscribeRealtimeBusSyncPing, teardownRealtimeBus, publishRealtimeBusSyncPing } = await import('./realtimeBus')
    subscribeRealtimeBusSyncPing('acc-1', vi.fn())
    expect(MockBroadcastChannel.instances).toHaveLength(1)

    teardownRealtimeBus('acc-1')
    expect(MockBroadcastChannel.instances[0].close).toHaveBeenCalledTimes(1)

    publishRealtimeBusSyncPing('acc-1', ['item-new'] as ItemId[])
    expect(MockBroadcastChannel.instances).toHaveLength(2)
    expect(MockBroadcastChannel.instances[1].name).toBe('flock-sync-ping-bus-acc-1')
  })

  it('ignores empty item lists or empty accountId when publishing', async () => {
    const { publishRealtimeBusSyncPing } = await import('./realtimeBus')
    publishRealtimeBusSyncPing('acc-1', [])
    publishRealtimeBusSyncPing('', ['item-1'] as ItemId[])
    expect(MockBroadcastChannel.instances).toHaveLength(0)
  })

  it('contains errors thrown by one listener so they do not block others', async () => {
    const { subscribeRealtimeBusSyncPing } = await import('./realtimeBus')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const badListener = vi.fn().mockImplementation(() => {
      throw new Error('Boom')
    })
    const goodListener = vi.fn()

    const unsub1 = subscribeRealtimeBusSyncPing('acc-1', badListener)
    const unsub2 = subscribeRealtimeBusSyncPing('acc-1', goodListener)

    const channel = MockBroadcastChannel.instances[0]
    const event = {
      data: {
        type: 'sync_ping',
        itemIds: ['item-c'],
      },
    } as MessageEvent

    if (channel && channel.onmessage) {
      channel.onmessage(event)
    }

    expect(badListener).toHaveBeenCalledWith(['item-c'])
    expect(goodListener).toHaveBeenCalledWith(['item-c'])
    expect(consoleErrorSpy).toHaveBeenCalled()

    unsub1()
    unsub2()
    consoleErrorSpy.mockRestore()
  })

  it('handles environments where BroadcastChannel is undefined without crashing', async () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const { subscribeRealtimeBusSyncPing, publishRealtimeBusSyncPing } = await import('./realtimeBus')

    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing('acc-1', listener)
    expect(typeof unsubscribe).toBe('function')

    expect(() => publishRealtimeBusSyncPing('acc-1', ['item-1'] as ItemId[])).not.toThrow()
    expect(() => unsubscribe()).not.toThrow()
  })

  it('handles environments where BroadcastChannel constructor throws without crashing', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    class ThrowingBroadcastChannel {
      constructor() {
        throw new Error('SecurityError: Access is denied')
      }
    }
    vi.stubGlobal('BroadcastChannel', ThrowingBroadcastChannel)

    const { subscribeRealtimeBusSyncPing, publishRealtimeBusSyncPing } = await import('./realtimeBus')

    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing('acc-1', listener)
    expect(typeof unsubscribe).toBe('function')

    expect(() => publishRealtimeBusSyncPing('acc-1', ['item-1'] as ItemId[])).not.toThrow()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[realtimeBus] BroadcastChannel is not supported or failed to initialize:',
      expect.any(Error)
    )
    expect(() => unsubscribe()).not.toThrow()
    consoleWarnSpy.mockRestore()
  })

  it('catches and warns when postMessage throws', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { publishRealtimeBusSyncPing } = await import('./realtimeBus')

    // Initial postMessage initializes channel
    publishRealtimeBusSyncPing('acc-1', ['item-1'] as ItemId[])
    const channel = MockBroadcastChannel.instances[0]
    channel.postMessage.mockImplementation(() => {
      throw new Error('DataCloneError')
    })

    expect(() => publishRealtimeBusSyncPing('acc-1', ['item-2'] as ItemId[])).not.toThrow()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[realtimeBus] Failed to post message to BroadcastChannel:',
      expect.any(Error)
    )
    consoleWarnSpy.mockRestore()
  })

  it('logs a warning on message deserialization error', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { subscribeRealtimeBusSyncPing } = await import('./realtimeBus')

    const unsubscribe = subscribeRealtimeBusSyncPing('acc-1', vi.fn())
    const channel = MockBroadcastChannel.instances[0]

    expect(channel.onmessageerror).toBeDefined()
    channel.onmessageerror!(new MessageEvent('messageerror'))
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[realtimeBus] Error deserializing message on BroadcastChannel:',
      expect.any(MessageEvent)
    )

    unsubscribe()
    consoleWarnSpy.mockRestore()
  })
})
