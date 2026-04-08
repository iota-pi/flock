import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Item } from './items'
import {
  useAuthReady,
  useItem,
  useItemMap,
  useItems,
  useLoggedIn,
} from './selectors'
import { useAuthStore } from './authStore'

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

vi.mock('../api/itemReadService', () => ({
  ensureItemsBootstrap: vi.fn(async () => undefined),
  ensureMetadataLoaded: vi.fn(async () => ({})),
  getCachedMetadata: vi.fn(() => ({})),
  subscribeMetadata: vi.fn(() => () => undefined),
}))

vi.mock('../sync/automergeDocStore', () => ({
  getAutomergeItems: vi.fn(() => itemsFixture),
  subscribeAutomergeItems: vi.fn(() => () => undefined),
}))

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: vi.fn(),
}))

describe('state selectors', () => {
  beforeEach(() => {
    useAuthStore.getState().setAccount({
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
