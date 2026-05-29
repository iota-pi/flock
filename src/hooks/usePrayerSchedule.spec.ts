import { renderHook, act } from '@testing-library/react'
import { usePrayerSchedule } from './usePrayerSchedule'


vi.mock('../state/selectors', () => ({
  usePrayerScheduleInputs: vi.fn(),
}))

vi.mock('../utils/prayer', () => ({
  getLastPrayedFor: vi.fn(),
  getNaturalPrayerGoal: vi.fn(),
  getPrayerSchedule: vi.fn(),
}))

vi.mock('./useToday', () => ({
  useToday: vi.fn(),
}))

vi.mock('src/features/items/mutations/itemMutations', () => ({
  mutateItem: vi.fn(async () => undefined),
}))

import { usePrayerScheduleInputs } from '../state/selectors'
import { getNaturalPrayerGoal, getPrayerSchedule, getLastPrayedFor } from '../utils/prayer'
import { useToday } from './useToday'
import { mutateItem } from 'src/features/items/mutations/itemMutations'
import { Item } from 'src/state/items'

describe('usePrayerSchedule', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(usePrayerScheduleInputs).mockReturnValue({
      items: [],
      prayerGoal: 3,
    })
    vi.mocked(useToday).mockReturnValue(new Date('2024-01-01T12:00:00'))

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

    vi.mocked(usePrayerScheduleInputs).mockReturnValue({
      items,
      prayerGoal: 3,
    })
    vi.mocked(getPrayerSchedule).mockReturnValue(ids)

    const { result } = renderHook(() => usePrayerSchedule())

    expect(result.current.scheduleIds).toEqual(ids)
    expect(result.current.visibleSchedule).toHaveLength(3)
    expect(result.current.visibleSchedule.map(i => i.id)).toEqual(['1', '2', '3'])
  })

  it('recordPrayerFor updates local state', () => {
    const item = { id: '1', type: 'person', name: 'Alice', prayedFor: [] }
    vi.mocked(getLastPrayedFor).mockReturnValue(0)

    const { result } = renderHook(() => usePrayerSchedule())

    act(() => {
      result.current.recordPrayerFor(item as any)
    })

    expect(mutateItem).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        prayedFor: expect.any(Array),
      }),
    )
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
