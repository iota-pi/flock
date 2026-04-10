import { renderHook, act } from '@testing-library/react'
import { usePrayerSchedule } from './usePrayerSchedule'
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../state/selectors', () => ({
  useItems: vi.fn(),
  useItemMap: vi.fn(),
  useMetadata: vi.fn(),
}))

vi.mock('../utils/prayer', () => ({
  getLastPrayedFor: vi.fn(),
  getNaturalPrayerGoal: vi.fn(),
  getPrayerSchedule: vi.fn(),
}))

vi.mock('./useToday', () => ({
  useToday: vi.fn(),
}))

vi.mock('../sync/automergeDocStore', () => ({
  applyAutomergeItemPatches: vi.fn(async () => undefined),
}))

vi.mock('../sync/automergeSyncDispatcher', () => ({
  requestAutomergeSync: vi.fn(),
}))

import { useItems, useItemMap, useMetadata } from '../state/selectors'
import { getNaturalPrayerGoal, getPrayerSchedule, getLastPrayedFor } from '../utils/prayer'
import { useToday } from './useToday'
import { applyAutomergeItemPatches } from '../sync/automergeDocStore'
import { requestAutomergeSync } from '../sync/automergeSyncDispatcher'
import { Item } from 'src/state/items'

describe('usePrayerSchedule', () => {
  const mockSetMetadata = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(useItems).mockReturnValue([])
    vi.mocked(useItemMap).mockReturnValue({})
    vi.mocked(useToday).mockReturnValue(new Date('2024-01-01T12:00:00'))
    vi.mocked(useMetadata).mockReturnValue([3, mockSetMetadata])

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

  it('recordPrayerFor updates local automerge doc and requests sync', () => {
    const item = { id: '1', type: 'person', name: 'Alice', prayedFor: [] }
    vi.mocked(getLastPrayedFor).mockReturnValue(0)

    const { result } = renderHook(() => usePrayerSchedule())

    act(() => {
      result.current.recordPrayerFor(item as any)
    })

    expect(applyAutomergeItemPatches).toHaveBeenCalledWith('1', [
      {
        op: 'replace',
        path: ['prayedFor'],
        value: expect.any(Array),
      },
    ])
    expect(requestAutomergeSync).toHaveBeenCalledWith(['1'])
  })

  it('isPrayedForToday returns correct status', () => {
    const today = new Date('2024-01-01T12:00:00')
    vi.mocked(useToday).mockReturnValue(today)

    const item = { id: '1' }

    vi.mocked(getLastPrayedFor).mockReturnValue(today.getTime())

    const { result } = renderHook(() => usePrayerSchedule())
    expect(result.current.isPrayedForToday(item as any)).toBe(true)

    vi.mocked(getLastPrayedFor).mockReturnValue(today.getTime() - 86400000)

    expect(result.current.isPrayedForToday(item as any)).toBe(false)
  })
})
