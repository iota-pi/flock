import type { ItemId } from '@vault/shared'
import { RealtimeBus, getIndexChannelName, getSyncPingChannelName } from './realtimeBus'

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

  /** Delivers a message as if another tab had posted it */
  receive(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}

function channelNamed(name: string): MockBroadcastChannel {
  const channel = MockBroadcastChannel.instances.find(instance => instance.name === name)
  if (!channel) throw new Error(`No channel named ${name}`)
  return channel
}

describe('RealtimeBus', () => {
  let bus: RealtimeBus

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    MockBroadcastChannel.instances = []
  })

  afterEach(() => {
    bus?.close()
    vi.unstubAllGlobals()
  })

  it("opens the account's sync ping and index channels", () => {
    bus = new RealtimeBus('acc-1')

    expect(MockBroadcastChannel.instances.map(channel => channel.name)).toEqual([
      getSyncPingChannelName('acc-1'),
      getIndexChannelName('acc-1'),
    ])
    expect(getSyncPingChannelName('acc-1')).toBe('test-vault-sync-ping-acc-1')
    expect(getIndexChannelName('acc-1')).toBe('test-vault-index-channel-acc-1')
  })

  it('delivers each kind of message to its own listeners', () => {
    bus = new RealtimeBus('acc-1')
    const ping = vi.fn()
    const dirty = vi.fn()
    const index = vi.fn()
    const metadata = vi.fn()
    bus.subscribeSyncPing(ping)
    bus.subscribeItemDirty(dirty)
    bus.subscribeIndexUpdated(index)
    bus.subscribeMetadataUpdated(metadata)

    const syncChannel = channelNamed(getSyncPingChannelName('acc-1'))
    const indexChannel = channelNamed(getIndexChannelName('acc-1'))
    syncChannel.receive({ type: 'sync_ping', itemIds: ['item-a'] })
    syncChannel.receive({ type: 'item_dirty', itemIds: ['item-b'] })
    indexChannel.receive({ type: 'indexUpdated', itemIds: ['item-c'] })
    indexChannel.receive({ type: 'metadataUpdated', metadata: { prayerGoal: 5 } })

    expect(ping.mock.calls).toEqual([[['item-a']]])
    expect(dirty.mock.calls).toEqual([[['item-b']]])
    expect(index.mock.calls).toEqual([[['item-c']]])
    expect(metadata.mock.calls).toEqual([[{ prayerGoal: 5 }]])
  })

  it('ignores malformed messages', () => {
    bus = new RealtimeBus('acc-1')
    const ping = vi.fn()
    const index = vi.fn()
    bus.subscribeSyncPing(ping)
    bus.subscribeIndexUpdated(index)

    channelNamed(getSyncPingChannelName('acc-1')).receive({ type: 'sync_ping' })
    channelNamed(getSyncPingChannelName('acc-1')).receive(null)
    channelNamed(getIndexChannelName('acc-1')).receive({ type: 'indexUpdated', itemIds: 'item-1' })

    expect(ping).not.toHaveBeenCalled()
    expect(index).not.toHaveBeenCalled()
  })

  it('publishes in the formats earlier releases read', () => {
    bus = new RealtimeBus('acc-1')
    bus.publishSyncPing(['item-1'] as ItemId[])
    bus.publishItemDirty(['item-2'] as ItemId[])
    bus.publishIndexUpdated(['item-3'] as ItemId[])
    bus.publishMetadataUpdated({ prayerGoal: 3 })

    expect(channelNamed(getSyncPingChannelName('acc-1')).postMessage.mock.calls).toEqual([
      [{ type: 'sync_ping', itemIds: ['item-1'] }],
      [{ type: 'item_dirty', itemIds: ['item-2'] }],
    ])
    expect(channelNamed(getIndexChannelName('acc-1')).postMessage.mock.calls).toEqual([
      [{ type: 'indexUpdated', itemIds: ['item-3'] }],
      [{ type: 'metadataUpdated', metadata: { prayerGoal: 3 } }],
    ])
  })

  it("doesn't publish empty item lists", () => {
    bus = new RealtimeBus('acc-1')
    bus.publishSyncPing([])
    bus.publishItemDirty([])

    expect(channelNamed(getSyncPingChannelName('acc-1')).postMessage).not.toHaveBeenCalled()
  })

  it('keeps separate sessions apart', () => {
    bus = new RealtimeBus('acc-1')
    const other = new RealtimeBus('acc-2')
    const ping = vi.fn()
    other.subscribeSyncPing(ping)

    channelNamed(getSyncPingChannelName('acc-1')).receive({ type: 'sync_ping', itemIds: ['item-1'] })

    expect(ping).not.toHaveBeenCalled()
    other.close()
  })

  it('stops notifying a listener once it unsubscribes', () => {
    bus = new RealtimeBus('acc-1')
    const ping = vi.fn()
    const unsubscribe = bus.subscribeSyncPing(ping)
    unsubscribe()
    unsubscribe()

    channelNamed(getSyncPingChannelName('acc-1')).receive({ type: 'sync_ping', itemIds: ['item-1'] })

    expect(ping).not.toHaveBeenCalled()
  })

  it('closes both channels and drops every listener on close', () => {
    bus = new RealtimeBus('acc-1')
    const ping = vi.fn()
    bus.subscribeSyncPing(ping)
    const syncChannel = channelNamed(getSyncPingChannelName('acc-1'))

    bus.close()
    syncChannel.receive({ type: 'sync_ping', itemIds: ['item-1'] })
    bus.publishSyncPing(['item-2'] as ItemId[])

    for (const channel of MockBroadcastChannel.instances) {
      expect(channel.close).toHaveBeenCalledTimes(1)
    }
    expect(ping).not.toHaveBeenCalled()
    expect(syncChannel.postMessage).not.toHaveBeenCalled()
  })

  it('contains errors thrown by one listener so they do not block others', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    bus = new RealtimeBus('acc-1')
    const bad = vi.fn(() => {
      throw new Error('Boom')
    })
    const good = vi.fn()
    bus.subscribeSyncPing(bad)
    bus.subscribeSyncPing(good)

    channelNamed(getSyncPingChannelName('acc-1')).receive({ type: 'sync_ping', itemIds: ['item-c'] })

    expect(bad).toHaveBeenCalledWith(['item-c'])
    expect(good).toHaveBeenCalledWith(['item-c'])
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('works without BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    bus = new RealtimeBus('acc-1')

    expect(() => bus.publishSyncPing(['item-1'] as ItemId[])).not.toThrow()
    expect(() => bus.subscribeSyncPing(vi.fn())()).not.toThrow()
  })

  it('warns when a BroadcastChannel cannot be created', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('BroadcastChannel', class {
      constructor() {
        throw new Error('SecurityError: Access is denied')
      }
    })

    bus = new RealtimeBus('acc-1')

    expect(() => bus.publishSyncPing(['item-1'] as ItemId[])).not.toThrow()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[realtimeBus] BroadcastChannel is not supported or failed to initialize:',
      expect.any(Error),
    )
    consoleWarnSpy.mockRestore()
  })

  it('warns when postMessage throws', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bus = new RealtimeBus('acc-1')
    channelNamed(getSyncPingChannelName('acc-1')).postMessage.mockImplementation(() => {
      throw new Error('DataCloneError')
    })

    expect(() => bus.publishSyncPing(['item-1'] as ItemId[])).not.toThrow()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[realtimeBus] Failed to post message to BroadcastChannel:',
      expect.any(Error),
    )
    consoleWarnSpy.mockRestore()
  })

  it('logs a warning on message deserialization error', () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    bus = new RealtimeBus('acc-1')

    channelNamed(getSyncPingChannelName('acc-1')).onmessageerror!(new MessageEvent('messageerror'))

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[realtimeBus] Error deserializing message on BroadcastChannel:',
      expect.any(MessageEvent),
    )
    consoleWarnSpy.mockRestore()
  })
})
