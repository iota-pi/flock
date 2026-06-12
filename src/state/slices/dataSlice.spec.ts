import { ItemId } from 'src/shared/schemas/items'
import { useAppStore } from '../store'

describe('dataSlice', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Explicitly reset the store state since we haven't implemented reset yet
    // or just clear the timer and call reset.
    useAppStore.setState({
      dataStatus: 'initializing',
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
    expect(useAppStore.getState().dataStatus).toBe('initializing')
    expect(useAppStore.getState().hasReceivedIndex).toBe(false)
  })

  it('should not transition to ready when receiving items before index', () => {
    useAppStore.getState().updateItemsFromServer([
      { id: 'item1', item: { id: 'item1', type: 'person' } as any }
    ])
    expect(useAppStore.getState().dataStatus).toBe('initializing')
    expect(useAppStore.getState().items).toHaveProperty('item1')
  })

  it('should transition to ready when receiving index after items', () => {
    useAppStore.getState().updateItemsFromServer([
      { id: 'item1', item: { id: 'item1', type: 'person' } as any }
    ])
    useAppStore.getState().updateIndexFromServer(['item1'] as ItemId[])
    expect(useAppStore.getState().dataStatus).toBe('ready')
  })

  it('should transition to ready immediately when receiving an empty index', () => {
    useAppStore.getState().updateIndexFromServer([])
    expect(useAppStore.getState().dataStatus).toBe('ready')
  })

  it('should transition to ready via fallback timeout if items are missing', () => {
    useAppStore.getState().updateIndexFromServer(['item1', 'item2'] as ItemId[])
    expect(useAppStore.getState().dataStatus).toBe('initializing')

    // Fast-forward time
    vi.advanceTimersByTime(5000)
    expect(useAppStore.getState().dataStatus).toBe('ready')
  })

  it('should reset state correctly', () => {
    useAppStore.getState().updateIndexFromServer(['item1'] as ItemId[])
    useAppStore.getState().updateItemsFromServer([
      { id: 'item1', item: { id: 'item1', type: 'person' } as any }
    ])
    expect(useAppStore.getState().dataStatus).toBe('ready')

    useAppStore.getState().reset()
    expect(useAppStore.getState().dataStatus).toBe('initializing')
    expect(useAppStore.getState().itemIds).toEqual([])
    expect(useAppStore.getState().items).toEqual({})
    expect(useAppStore.getState().hasReceivedIndex).toBe(false)
  })
})
