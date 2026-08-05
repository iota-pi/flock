import { ItemId } from 'src/shared/schemas/items'

// Create the mock BroadcastChannel class
class MockBroadcastChannel {
  name: string
  onmessage: ((ev: MessageEvent) => any) | null = null
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
    MockBroadcastChannel.instances = []
    vi.clearAllMocks()
  })

  it('initializes the BroadcastChannel on subscription and registers listeners', async () => {
    const { subscribeRealtimeBusSyncPing } = await import('./realtimeBus')
    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing(listener)

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    const channel = MockBroadcastChannel.instances[0]
    expect(channel.name).toBe('flock-sync-ping-bus')

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

  it('does not notify unsubscribed listeners', async () => {
    const { subscribeRealtimeBusSyncPing } = await import('./realtimeBus')
    const listener = vi.fn()
    const unsubscribe = subscribeRealtimeBusSyncPing(listener)
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

  it('publishes messages through the BroadcastChannel', async () => {
    const { publishRealtimeBusSyncPing } = await import('./realtimeBus')
    // Calling publishRealtimeBusSyncPing should initialize the channel and postMessage
    publishRealtimeBusSyncPing(['item-1', 'item-2'] as ItemId[])

    expect(MockBroadcastChannel.instances).toHaveLength(1)
    const channel = MockBroadcastChannel.instances[0]
    expect(channel.postMessage).toHaveBeenCalledWith({
      type: 'sync_ping',
      itemIds: ['item-1', 'item-2'],
    })
  })

  it('ignores empty item lists when publishing', async () => {
    const { publishRealtimeBusSyncPing } = await import('./realtimeBus')
    publishRealtimeBusSyncPing([])
    expect(MockBroadcastChannel.instances).toHaveLength(0)
  })

  it('contains errors thrown by one listener so they do not block others', async () => {
    const { subscribeRealtimeBusSyncPing } = await import('./realtimeBus')
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const badListener = vi.fn().mockImplementation(() => {
      throw new Error('Boom')
    })
    const goodListener = vi.fn()

    const unsub1 = subscribeRealtimeBusSyncPing(badListener)
    const unsub2 = subscribeRealtimeBusSyncPing(goodListener)

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
})
