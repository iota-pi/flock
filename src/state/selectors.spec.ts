import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from './items'
import {
  useAuthReady,
  useItem,
  useItemIds,
  useItemsByIds,
  useLoggedIn,
  usePracticalFilterCount,
  usePrayerScheduleInputs,
  useSearchItems,
  useSortCriteria,
  useVisibleItems,
} from './selectors'
import { useAuthStore } from './authStore'
import { useUiStore } from './uiStore'
import { DEFAULT_FILTER_CRITERIA } from '../utils/customFilter'

const useAutomergeMocks = vi.hoisted(() => ({
  useAutomergeItems: vi.fn(),
  useAutomergeItemsById: vi.fn(),
  useAutomergeItem: vi.fn(),
  useAutomergeMetadataValue: vi.fn(),
}))

vi.mock('../features/items/mutations/itemMutations', () => ({
  setMetadata: vi.fn(async () => ({})),
}))

vi.mock('../sync/useAutomerge', () => ({
  useAutomergeItems: useAutomergeMocks.useAutomergeItems,
  useAutomergeItemsById: useAutomergeMocks.useAutomergeItemsById,
  useAutomergeItem: useAutomergeMocks.useAutomergeItem,
  useAutomergeMetadataValue: useAutomergeMocks.useAutomergeMetadataValue,
}))

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

let automergeItemsState: Item[] = itemsFixture
let automergeMetadataState: Record<string, unknown> = {}

describe('state selectors', () => {
  beforeEach(() => {
    automergeItemsState = itemsFixture
    automergeMetadataState = {}

    useAutomergeMocks.useAutomergeItems.mockImplementation(() => automergeItemsState)
    useAutomergeMocks.useAutomergeItemsById.mockImplementation((ids: string[]) => ids
      .map(itemId => automergeItemsState.find(item => item.id === itemId))
      .filter((item): item is Item => item !== undefined))
    useAutomergeMocks.useAutomergeItem.mockImplementation((itemId: string) => (
      automergeItemsState.find(item => item.id === itemId) || null
    ))
    useAutomergeMocks.useAutomergeMetadataValue.mockImplementation(
      (key: string, defaultValue?: unknown) => {
        const metadataValue = automergeMetadataState[key]
        return metadataValue === undefined ? defaultValue : metadataValue
      },
    )

    useAuthStore.getState().updateAuth({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })

    useUiStore.setState({
      filters: DEFAULT_FILTER_CRITERIA,
    })
  })

  it('useLoggedIn and useAuthReady read auth store flags', () => {
    const loggedIn = renderHook(() => useLoggedIn())
    const ready = renderHook(() => useAuthReady())

    expect(loggedIn.result.current).toBe(true)
    expect(ready.result.current).toBe(true)
  })

  it('useVisibleItems returns full list', () => {
    const { result } = renderHook(() => useVisibleItems())
    expect(result.current.map((item: Item) => item.id)).toEqual(['person-1', 'group-1', 'topic-1'])
  })

  it('useItemIds filters by type', () => {
    const { result } = renderHook(() => useItemIds('person'))
    expect(result.current).toEqual(['person-1'])
  })

  it('useItemIds keeps stable typed list when unrelated item changes', () => {
    const { result, rerender } = renderHook(() => useItemIds('group'))
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => (
        item.id === 'person-1'
          ? { ...item, name: 'Alice Updated' }
          : item
      ))
      rerender()
    })

    expect(result.current).toBe(firstResult)
    expect(result.current).toEqual(['group-1'])
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
      isOpen: true,
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

    const { result, rerender } = renderHook(() => useSearchItems(options))
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => ({ ...item }))
      rerender()
    })

    expect(result.current).toBe(firstResult)
  })

  it('useSearchItems returns a new snapshot when visible item data changes', () => {
    const options = {
      isOpen: true,
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

    const { result, rerender } = renderHook(() => useSearchItems(options))
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => (
        item.id === 'person-1'
          ? { ...item, name: 'Alice Updated' }
          : item
      ))
      rerender()
    })

    expect(result.current).not.toBe(firstResult)
    expect(result.current.items.find(item => item.id === 'person-1')?.name).toBe('Alice Updated')
  })

  it('usePrayerScheduleInputs keeps stable snapshot for semantically unchanged updates', () => {
    const { result, rerender } = renderHook(() => usePrayerScheduleInputs())
    const firstResult = result.current

    act(() => {
      automergeItemsState = automergeItemsState.map(item => ({ ...item }))
      automergeMetadataState = { ...automergeMetadataState }
      rerender()
    })

    expect(result.current).toBe(firstResult)
  })

  it('usePrayerScheduleInputs returns new snapshot when prayerGoal changes', () => {
    const { result, rerender } = renderHook(() => usePrayerScheduleInputs())
    const firstResult = result.current

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        prayerGoal: 7,
      }
      rerender()
    })

    expect(result.current).not.toBe(firstResult)
    expect(result.current.prayerGoal).toBe(7)
  })

  it('useSortCriteria keeps stable value for semantically unchanged metadata snapshots', () => {
    const { result, rerender } = renderHook(() => useSortCriteria())
    const firstSortCriteria = result.current[0]

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        sortCriteria: [{ type: 'name', reverse: false }],
      }
      rerender()
    })

    expect(result.current[0]).toBe(firstSortCriteria)

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        prayerGoal: 9,
      }
      rerender()
    })

    expect(result.current[0]).toBe(firstSortCriteria)

    act(() => {
      automergeMetadataState = {
        ...automergeMetadataState,
        sortCriteria: [{ type: 'created', reverse: false }],
      }
      rerender()
    })

    expect(result.current[0]).not.toBe(firstSortCriteria)
    expect(result.current[0]).toEqual([{ type: 'created', reverse: false }])
  })

  it('usePracticalFilterCount ignores default archived=false filter', () => {
    const { result } = renderHook(() => usePracticalFilterCount())

    expect(result.current).toBe(0)
  })

  it('usePracticalFilterCount counts user filters beyond the default archived filter', () => {
    useUiStore.setState({
      filters: [
        ...DEFAULT_FILTER_CRITERIA,
        {
          type: 'name',
          baseOperator: 'contains',
          inverse: false,
          operator: 'contains',
          value: 'alice',
        },
      ],
    })

    const { result } = renderHook(() => usePracticalFilterCount())

    expect(result.current).toBe(1)
  })
})
