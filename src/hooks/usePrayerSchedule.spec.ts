import { renderHook, act } from '@testing-library/react'
import { usePrayerSchedule } from './usePrayerSchedule'
import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mocks
vi.mock('../state/selectors', () => ({
  useItems: vi.fn(),
  useItemMap: vi.fn(),
  useMetadata: vi.fn(),
}))
vi.mock('../api/queries', () => ({
  useStoreItemsMutation: vi.fn(),
}))
vi.mock('../utils/prayer', () => ({
  getLastPrayedFor: vi.fn(),
  getNaturalPrayerGoal: vi.fn(),
  getPrayerSchedule: vi.fn(),
}))
vi.mock('./useToday', () => ({
  useToday: vi.fn(),
}))

import { useItems, useItemMap, useMetadata } from '../state/selectors'
import { useStoreItemsMutation } from '../api/queries'
import { getNaturalPrayerGoal, getPrayerSchedule, getLastPrayedFor } from '../utils/prayer'
import { useToday } from './useToday'
import { Item } from 'src/state/items'

describe('usePrayerSchedule', () => {
  const mockStoreItems = vi.fn()
  const mockSetMetadata = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(useItems).mockReturnValue([])
    vi.mocked(useItemMap).mockReturnValue({})
    vi.mocked(useToday).mockReturnValue(new Date('2024-01-01T12:00:00'))
    vi.mocked(useMetadata).mockReturnValue([3, mockSetMetadata])

    vi.mocked(useStoreItemsMutation).mockReturnValue({ mutate: mockStoreItems } as any)

    vi.mocked(getNaturalPrayerGoal).mockReturnValue(5)
    vi.mocked(getPrayerSchedule).mockReturnValue([])
    vi.mocked(getLastPrayedFor).mockReturnValue(0)
  })

  it('initializes with default values', () => {
    const { result } = renderHook(() => usePrayerSchedule())

    expect(result.current.goal).toBe(3)
    expect(result.current.naturalGoal).toBe(5)
    expect(result.current.scheduleIds).toEqual([])
    expect(result.current.visibleSchedule).toEqual([])
    expect(result.current.completed).toBe(0)
  })

  it('updates todaysGoal when metadata changes', () => {
    vi.mocked(useMetadata).mockReturnValue([10, mockSetMetadata])
    const { result } = renderHook(() => usePrayerSchedule())
    expect(result.current.goal).toBe(10)
  })

  it('calculates visibleSchedule based on goal', () => {
    const ids = ['1', '2', '3', '4', '5']
    const items = ids.map(id => ({ id, name: `Item ${id}` } as Item))
    const itemMap = Object.fromEntries(items.map(i => [i.id, i]))

    vi.mocked(useItems).mockReturnValue(items)
    vi.mocked(useItemMap).mockReturnValue(itemMap)
    vi.mocked(getPrayerSchedule).mockReturnValue(ids)

    const { result } = renderHook(() => usePrayerSchedule())

    expect(result.current.scheduleIds).toEqual(ids)
    expect(result.current.visibleSchedule).toHaveLength(3)
    expect(result.current.visibleSchedule.map(i => i.id)).toEqual(['1', '2', '3'])
  })

  it('showMore increases visible schedule', () => {
    const ids = ['1', '2', '3', '4', '5', '6', '7']
    const items = ids.map(id => ({ id, name: `Item ${id}` } as Item))
    const itemMap = Object.fromEntries(items.map(i => [i.id, i]))

    vi.mocked(useItems).mockReturnValue(items)
    vi.mocked(useItemMap).mockReturnValue(itemMap)
    vi.mocked(getPrayerSchedule).mockReturnValue(ids)

    const { result } = renderHook(() => usePrayerSchedule())

    expect(result.current.visibleSchedule).toHaveLength(3)

    act(() => {
      result.current.showMore()
    })

    expect(result.current.visibleSchedule).toHaveLength(6)
  })

  it('recordPrayerFor calls storeItems', () => {
    const item = { id: '1', name: 'Alice', prayedFor: [] }
    vi.mocked(getLastPrayedFor).mockReturnValue(0)

    const { result } = renderHook(() => usePrayerSchedule())

    act(() => {
      result.current.recordPrayerFor(item as any)
    })

    expect(mockStoreItems).toHaveBeenCalled()
    expect(mockStoreItems.mock.calls[0][0].prayedFor).toHaveLength(1)
  })

  it('isPrayedForToday returns correct status', () => {
    const today = new Date('2024-01-01T12:00:00')
    vi.mocked(useToday).mockReturnValue(today)

    const item = { id: '1' }

    // Mock helper to return today's timestamp
    vi.mocked(getLastPrayedFor).mockReturnValue(today.getTime())

    const { result } = renderHook(() => usePrayerSchedule())
    expect(result.current.isPrayedForToday(item as any)).toBe(true)

    // Mock helper to return yesterday
    vi.mocked(getLastPrayedFor).mockReturnValue(today.getTime() - 86400000)

    expect(result.current.isPrayedForToday(item as any)).toBe(false)
  })

  it('toggling prayer (removing) works', () => {
    const today = new Date('2024-01-01T12:00:00')
    vi.useFakeTimers()
    vi.setSystemTime(today)

    vi.mocked(useToday).mockReturnValue(today)
    vi.mocked(getLastPrayedFor).mockReturnValue(today.getTime())

    const item = { id: '1', prayedFor: [today.getTime()] }

    const { result } = renderHook(() => usePrayerSchedule())

    act(() => {
      result.current.recordPrayerFor(item as any, true)
    })

    expect(mockStoreItems).toHaveBeenCalled()
    const savedItem = mockStoreItems.mock.calls[0][0]
    // Should filter out today's prayer.
    expect(savedItem.prayedFor.length).toBe(0)

    vi.useRealTimers()
  })
})
