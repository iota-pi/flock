import { act, renderHook } from '@testing-library/react'

import type { Item } from './items'
import {
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
import { useAppStore } from './store'
import { DEFAULT_FILTER_CRITERIA } from '../utils/customFilter'
import { ItemId } from 'src/shared/schemas/items'


vi.mock('../features/items/mutations/itemMutations', () => ({
  setMetadata: vi.fn(async () => ({})),
}))

const itemsFixture: Item[] = [
  {
    id: 'person-1' as ItemId,
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
    id: 'group-1' as ItemId,
    type: 'group',
    name: 'Core Group',
    members: ['person-1'] as ItemId[],
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
    id: 'topic-1' as ItemId,
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

let itemsState: Item[] = itemsFixture
let metadataState: Record<string, unknown> = {}

describe('state selectors', () => {
  function updateStore() {
    const itemsMap: Record<string, Item> = {}
    itemsState.forEach(item => {
      itemsMap[item.id] = item
    })

    useAppStore.setState({
      dataStatus: 'ready',
      items: itemsMap,
      itemIds: itemsState.map(i => i.id),
      metadata: metadataState,
    })
  }

  beforeEach(() => {
    itemsState = itemsFixture
    metadataState = {}

    updateStore()

    useAppStore.getState().updateAuth({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })

    useAppStore.setState({
      filters: DEFAULT_FILTER_CRITERIA,
    })
  })

  it('useLoggedIn read auth store flags', () => {
    const loggedIn = renderHook(() => useLoggedIn())

    expect(loggedIn.result.current).toBe(true)
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
      itemsState = itemsState.map(item => (
        item.id === 'person-1'
          ? { ...item, name: 'Alice Updated' }
          : item
      ))
      updateStore()
      rerender()
    })

    expect(result.current).toBe(firstResult)
    expect(result.current).toEqual(['group-1'])
  })


  it('useItem returns the selected item by id', () => {
    const { result } = renderHook(() => useItem('topic-1' as ItemId))
    expect(result.current?.name).toBe('Hope')
  })

  it('useItemsByIds returns selected items and keeps stable reference for unchanged ids', () => {
    const { result, rerender } = renderHook(
      ({ ids }) => useItemsByIds(ids),
      {
        initialProps: {
          ids: ['group-1', 'person-1'] as ItemId[],
        },
      },
    )

    expect(result.current.map(item => item.id)).toEqual(['group-1', 'person-1'])

    const firstResult = result.current
    rerender({ ids: ['group-1', 'person-1'] as ItemId[] })
    expect(result.current).toBe(firstResult)

    rerender({ ids: ['topic-1'] as ItemId[] })
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
      itemsState = itemsState.map(item => ({ ...item }))
      updateStore()
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
      itemsState = itemsState.map(item => (
        item.id === 'person-1'
          ? { ...item, name: 'Alice Updated' }
          : item
      ))
      updateStore()
      rerender()
    })

    expect(result.current).not.toBe(firstResult)
    expect(result.current.find(item => item.id === 'person-1')?.name).toBe('Alice Updated')
  })

  it('usePrayerScheduleInputs keeps stable snapshot for semantically unchanged updates', () => {
    const { result, rerender } = renderHook(() => usePrayerScheduleInputs())
    const firstResult = result.current

    act(() => {
      itemsState = itemsState.map(item => ({ ...item }))
      metadataState = { ...metadataState }
      updateStore()
      rerender()
    })

    expect(result.current).toBe(firstResult)
  })

  it('usePrayerScheduleInputs returns new snapshot when prayerGoal changes', () => {
    const { result, rerender } = renderHook(() => usePrayerScheduleInputs())
    const firstResult = result.current

    act(() => {
      metadataState = {
        ...metadataState,
        prayerGoal: 7,
      }
      updateStore()
      rerender()
    })

    expect(result.current).not.toBe(firstResult)
    expect(result.current.prayerGoal).toBe(7)
  })

  it('useSortCriteria keeps stable value for semantically unchanged metadata snapshots', () => {
    const { result, rerender } = renderHook(() => useSortCriteria())
    const firstSortCriteria = result.current[0]

    act(() => {
      metadataState = {
        ...metadataState,
        sortCriteria: [{ type: 'name', reverse: false }],
      }
      updateStore()
      rerender()
    })

    expect(result.current[0]).toBe(firstSortCriteria)

    act(() => {
      metadataState = {
        ...metadataState,
        prayerGoal: 9,
      }
      updateStore()
      rerender()
    })

    expect(result.current[0]).toBe(firstSortCriteria)

    act(() => {
      metadataState = {
        ...metadataState,
        sortCriteria: [{ type: 'created', reverse: false }],
      }
      updateStore()
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
    useAppStore.setState({
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
