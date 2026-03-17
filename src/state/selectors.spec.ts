import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from './items'
import {
  useAuthInitializing,
  useItem,
  useItemMap,
  useItems,
  useLoggedIn,
} from './selectors'
import { useAuthStore } from './authStore'

const itemsFixture: Item[] = [
  { id: 'person-1', type: 'person', name: 'Alice', version: 1 } as Item,
  { id: 'group-1', type: 'group', name: 'Core Group', members: ['person-1'], version: 1 } as Item,
  { id: 'topic-1', type: 'topic', name: 'Hope', version: 1 } as Item,
]

vi.mock('../api/queries', () => ({
  useItemsQuery: (options?: { enabled?: boolean, select?: (items: Item[]) => unknown }) => {
    if (options?.enabled === false) {
      return { data: undefined }
    }
    return {
      data: options?.select ? options.select(itemsFixture) : itemsFixture,
    }
  },
  useMetadataQuery: () => ({ data: {} }),
  useSetMetadataMutation: () => ({ mutateAsync: vi.fn() }),
}))

describe('state selectors', () => {
  beforeEach(() => {
    useAuthStore.getState().setAccount({
      account: 'acct-1',
      loggedIn: true,
      initializing: false,
    })
  })

  it('useLoggedIn and useAuthInitializing read auth store flags', () => {
    const loggedIn = renderHook(() => useLoggedIn())
    const initializing = renderHook(() => useAuthInitializing())

    expect(loggedIn.result.current).toBe(true)
    expect(initializing.result.current).toBe(false)
  })

  it('useItems returns full list when no type filter is passed', () => {
    const { result } = renderHook(() => useItems())
    expect(result.current.map(item => item.id)).toEqual(['person-1', 'group-1', 'topic-1'])
  })

  it('useItems filters by type using query select', () => {
    const { result } = renderHook(() => useItems<Item>('person'))
    expect(result.current.map(item => item.id)).toEqual(['person-1'])
  })

  it('useItemMap returns an id keyed item map', () => {
    const { result } = renderHook(() => useItemMap())
    expect(result.current['person-1']?.name).toBe('Alice')
    expect(result.current['group-1']?.name).toBe('Core Group')
  })

  it('useItem returns the selected item by id', () => {
    const { result } = renderHook(() => useItem('topic-1'))
    expect(result.current?.name).toBe('Hope')
  })
})