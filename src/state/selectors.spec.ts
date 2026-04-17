import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from './items'
import {
  useAuthReady,
  useItem,
  useItemMap,
  useItems,
  useItemsByIds,
  usePrayerScheduleInputs,
  useSearchItems,
  useSortCriteria,
  useLoggedIn,
} from './selectors'
import { useAuthStore } from './authStore'
import {
  getAutomergeItem,
  getAutomergeItems,
  getAutomergeMetadata,
  subscribeAutomergeItem,
  subscribeAutomergeItems,
  subscribeAutomergeMetadata,
  subscribeAutomergeSnapshots,
} from '../sync/automergeDocStore'

const itemsFixture: Item[] = [
  {
    id: 'person-1',
    type: 'person',
    name: 'Alice',
    archived: false,
    created: 0,
    description: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
  },
  {
    id: 'group-1',
    type: 'group',
    name: 'Core Group',
    members: ['person-1'],
    memberPrayerFrequency: 'none',
    memberPrayerTarget: 'one',
    archived: false,
    created: 0,
    description: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
  },
  {
    id: 'topic-1',
    type: 'topic',
    name: 'Hope',
    archived: false,
    created: 0,
    description: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
  },
]

const useAutomergeMocks = vi.hoisted(() => ({
  useAutomergeItem: vi.fn(),
  useAutomergeMetadataSnapshot: vi.fn(() => ({})),
}))

vi.mock('../api/itemReadService', () => ({
  ensureItemsBootstrap: vi.fn(async () => undefined),
  ensureMetadataLoaded: vi.fn(async () => ({})),
  getCachedMetadata: vi.fn(() => ({})),
  subscribeMetadata: vi.fn(() => () => undefined),
}))

vi.mock('../sync/automergeDocStore', () => ({
  getAutomergeItems: vi.fn(),
  getAutomergeItem: vi.fn(),
  getAutomergeMetadata: vi.fn(),
  subscribeAutomergeItem: vi.fn(),
  subscribeAutomergeItems: vi.fn(),
  subscribeAutomergeMetadata: vi.fn(),
  subscribeAutomergeSnapshots: vi.fn(),
}))

vi.mock('../sync/useAutomerge', () => ({
  useAutomergeItem: useAutomergeMocks.useAutomergeItem,
  useAutomergeMetadataSnapshot: useAutomergeMocks.useAutomergeMetadataSnapshot,
}))

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: vi.fn(),
}))

let automergeItemsState: Item[] = itemsFixture
let automergeMetadataState: Record<string, unknown> = {}
let automergeListeners = new Set<() => void>()

function emitAutomergeSnapshot() {
  for (const listener of Array.from(automergeListeners)) {
    listener()
  }
}

describe('state selectors', () => {
  beforeEach(() => {
    automergeItemsState = itemsFixture
    automergeMetadataState = {}
    automergeListeners = new Set()

    vi.mocked(getAutomergeItems).mockImplementation(() => automergeItemsState)
    vi.mocked(getAutomergeItem).mockImplementation((itemId: string) => (
      automergeItemsState.find(item => item.id === itemId) || null
    ))
    vi.mocked(getAutomergeMetadata).mockImplementation(() => automergeMetadataState)
    vi.mocked(subscribeAutomergeSnapshots).mockImplementation(listener => {
      automergeListeners.add(listener)
      return () => {
        automergeListeners.delete(listener)
      }
    })
    vi.mocked(subscribeAutomergeItems).mockImplementation(listener => {
      automergeListeners.add(listener)
      return () => {
        automergeListeners.delete(listener)
      }
    })
    vi.mocked(subscribeAutomergeMetadata).mockImplementation(listener => {
      automergeListeners.add(listener)
      return () => {
        automergeListeners.delete(listener)
      }
    })
    vi.mocked(subscribeAutomergeItem).mockImplementation((_itemId, listener) => {
      automergeListeners.add(listener)
      return () => {
        automergeListeners.delete(listener)
      }
    })
    useAutomergeMocks.useAutomergeItem.mockImplementation((itemId: string) => (
      automergeItemsState.find(item => item.id === itemId) || null
    ))
    useAutomergeMocks.useAutomergeMetadataSnapshot.mockImplementation(() => automergeMetadataState as any)

    useAuthStore.getState().updateAuth({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })
  })

  it('useLoggedIn and useAuthReady read auth store flags', () => {
    const loggedIn = renderHook(() => useLoggedIn())
    const ready = renderHook(() => useAuthReady())

    expect(loggedIn.result.current).toBe(true)
    expect(ready.result.current).toBe(true)
  })

  it('useItems returns full list when no type filter is passed', () => {
    const { result } = renderHook(() => useItems())
    expect(result.current.map(item => item.id)).toEqual(['person-1', 'group-1', 'topic-1'])
  })

  it('useItems filters by type', () => {
    const { result } = renderHook(() => useItems<Item>('person'))
    expect(result.current.map(item => item.id)).toEqual(['person-1'])
  })

  it('useItems keeps stable typed list when unrelated item changes', () => {
    const { result } = renderHook(() => useItems<Item>('group'))
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => (
        item.id === 'person-1'
          ? { ...item, name: 'Alice Updated' }
          : item
      ))
      emitAutomergeSnapshot()
    })

    expect(result.current).toBe(firstResult)
    expect(result.current.map(item => item.id)).toEqual(['group-1'])
  })

  it('useItemMap returns an id keyed item map', () => {
    const { result } = renderHook(() => useItemMap())
    expect(result.current['person-1']?.name).toBe('Alice')
    expect(result.current['group-1']?.name).toBe('Core Group')
  })

  it('useItemMap keeps stable map for semantically unchanged updates', () => {
    const { result } = renderHook(() => useItemMap())
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => ({ ...item }))
      emitAutomergeSnapshot()
    })

    expect(result.current).toBe(firstResult)
  })

  it('useItem returns the selected item by id', () => {
    const { result } = renderHook(() => useItem('topic-1'))
    expect(result.current?.name).toBe('Hope')
  })

  it('useItemsByIds returns selected items and keeps stable reference for unchanged ids', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useItemsByIds(ids),
      {
        initialProps: {
          ids: ['group-1', 'person-1'],
        },
      },
    )

    expect(result.current.map(item => item.id)).toEqual(['group-1', 'person-1'])

    const firstResult = result.current
    rerender({ ids: ['group-1', 'person-1'] })
    expect(result.current).toBe(firstResult)

    rerender({ ids: ['topic-1'] })
    expect(result.current.map(item => item.id)).toEqual(['topic-1'])
  })

  it('useSearchItems keeps stable snapshot when item references change but values do not', () => {
    const options = {
      includeArchived: false,
      selectedItemIds: [],
      showSelectedOptions: false,
      types: {
        group: true,
        person: true,
        topic: true,
        error: true,
      },
    }

    const { result } = renderHook(() => useSearchItems(options))
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => ({ ...item }))
      emitAutomergeSnapshot()
    })

    expect(result.current).toBe(firstResult)
  })

  it('useSearchItems returns a new snapshot when visible item data changes', () => {
    const options = {
      includeArchived: false,
      selectedItemIds: [],
      showSelectedOptions: false,
      types: {
        group: true,
        person: true,
        topic: true,
        error: true,
      },
    }

    const { result } = renderHook(() => useSearchItems(options))
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => (
        item.id === 'person-1'
          ? { ...item, name: 'Alice Updated' }
          : item
      ))
      emitAutomergeSnapshot()
    })

    expect(result.current).not.toBe(firstResult)
    expect(result.current.items.find(item => item.id === 'person-1')?.name).toBe('Alice Updated')
  })

  it('usePrayerScheduleInputs keeps stable snapshot for semantically unchanged updates', () => {
    const { result } = renderHook(() => usePrayerScheduleInputs())
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => ({ ...item }))
      automergeMetadataState = { ...automergeMetadataState }
      emitAutomergeSnapshot()
    })

    expect(result.current).toBe(firstResult)
  })

  it('usePrayerScheduleInputs returns new snapshot when prayerGoal changes', () => {
    const { result } = renderHook(() => usePrayerScheduleInputs())
    const firstResult = result.current

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        prayerGoal: 7,
      }
      emitAutomergeSnapshot()
    })

    expect(result.current).not.toBe(firstResult)
    expect(result.current.prayerGoal).toBe(7)
  })

  it('useSortCriteria keeps stable value for semantically unchanged metadata snapshots', () => {
    const { result } = renderHook(() => useSortCriteria())
    const firstSortCriteria = result.current[0]

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        sortCriteria: [{ type: 'name', reverse: false }],
      }
      emitAutomergeSnapshot()
    })

    expect(result.current[0]).toBe(firstSortCriteria)

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        prayerGoal: 9,
      }
      emitAutomergeSnapshot()
    })

    expect(result.current[0]).toBe(firstSortCriteria)

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        sortCriteria: [{ type: 'created', reverse: false }],
      }
      emitAutomergeSnapshot()
    })

    expect(result.current[0]).not.toBe(firstSortCriteria)
    expect(result.current[0]).toEqual([{ type: 'created', reverse: false }])
  })
})
