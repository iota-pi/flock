import { ItemId } from 'src/shared/schemas/items'
import { useDataStore } from './dataStore'

describe('dataStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Explicitly reset the store state since we haven't implemented reset yet
    // or just clear the timer and call reset.
    useDataStore.setState({
      status: 'initializing',
      items: {},
      itemIds: [],
      metadata: {},
      processedItemIds: new Set<string>(),
      hasReceivedIndex: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts in initializing status', () => {
    expect(useDataStore.getState().status).toBe('initializing')
    expect(useDataStore.getState().hasReceivedIndex).toBe(false)
  })

  it('should not transition to ready when receiving items before index', () => {
    useDataStore.getState().updateItemsFromServer([
      { id: 'item1', item: { id: 'item1', type: 'person' } as any }
    ])
    expect(useDataStore.getState().status).toBe('initializing')
    expect(useDataStore.getState().items).toHaveProperty('item1')
  })

  it('should transition to ready when receiving index after items', () => {
    useDataStore.getState().updateItemsFromServer([
      { id: 'item1', item: { id: 'item1', type: 'person' } as any }
    ])
    useDataStore.getState().updateIndexFromServer(['item1'] as ItemId[])
    expect(useDataStore.getState().status).toBe('ready')
  })

  it('should transition to ready immediately when receiving an empty index', () => {
    useDataStore.getState().updateIndexFromServer([])
    expect(useDataStore.getState().status).toBe('ready')
  })

  it('should transition to ready via fallback timeout if items are missing', () => {
    useDataStore.getState().updateIndexFromServer(['item1', 'item2'] as ItemId[])
    expect(useDataStore.getState().status).toBe('initializing')

    // Fast-forward time
    vi.advanceTimersByTime(5000)
    expect(useDataStore.getState().status).toBe('ready')
  })

  it('should reset state correctly', () => {
    useDataStore.getState().updateIndexFromServer(['item1'] as ItemId[])
    useDataStore.getState().updateItemsFromServer([
      { id: 'item1', item: { id: 'item1', type: 'person' } as any }
    ])
    expect(useDataStore.getState().status).toBe('ready')

    useDataStore.getState().reset()
    expect(useDataStore.getState().status).toBe('initializing')
    expect(useDataStore.getState().itemIds).toEqual([])
    expect(useDataStore.getState().items).toEqual({})
    expect(useDataStore.getState().hasReceivedIndex).toBe(false)
  })
})
