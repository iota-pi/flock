import { renderHook } from '@testing-library/react'
import { useAutoClearPrayerNotifications } from './useAutoClearPrayerNotifications'
import { useAppStore } from '../state/store'

vi.mock('../state/selectors', () => ({
  useLoggedIn: vi.fn(),
  usePrayerScheduleInputs: vi.fn(),
  useMetadata: vi.fn(),
}))

vi.mock('./useToday', () => ({
  useToday: vi.fn(),
}))

vi.mock('../utils/prayer', () => ({
  isPrayerCompletedForToday: vi.fn(),
}))

vi.mock('../utils/pushNotifications', () => ({
  clearReminderNotifications: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../api/vault', () => ({
  snoozeReminders: vi.fn().mockResolvedValue(undefined),
}))

import { useLoggedIn, usePrayerScheduleInputs, useMetadata } from '../state/selectors'
import { useToday } from './useToday'
import { isPrayerCompletedForToday } from '../utils/prayer'
import { clearReminderNotifications } from '../utils/pushNotifications'
import { snoozeReminders } from '../api/vault'

describe('useAutoClearPrayerNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    useAppStore.setState({
      account: 'test-account',
      dataStatus: 'ready',
    })

    vi.mocked(useLoggedIn).mockReturnValue(true)
    vi.mocked(useToday).mockReturnValue(new Date('2026-10-02T10:00:00'))
    vi.mocked(usePrayerScheduleInputs).mockReturnValue({
      items: [],
      prayerGoal: 3,
    })
    vi.mocked(useMetadata).mockReturnValue([true, vi.fn()])
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(false)
  })

  it('does nothing when not logged in', () => {
    vi.mocked(useLoggedIn).mockReturnValue(false)
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(true)

    renderHook(() => useAutoClearPrayerNotifications())

    expect(clearReminderNotifications).not.toHaveBeenCalled()
    expect(snoozeReminders).not.toHaveBeenCalled()
  })

  it('does nothing when dataStatus is initializing', () => {
    useAppStore.setState({ dataStatus: 'initializing' })
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(true)

    renderHook(() => useAutoClearPrayerNotifications())

    expect(clearReminderNotifications).not.toHaveBeenCalled()
    expect(snoozeReminders).not.toHaveBeenCalled()
  })

  it('does nothing when prayer is not completed for today', () => {
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(false)

    renderHook(() => useAutoClearPrayerNotifications())

    expect(clearReminderNotifications).not.toHaveBeenCalled()
    expect(snoozeReminders).not.toHaveBeenCalled()
  })

  it('clears notifications and snoozes reminders when prayer is completed', () => {
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(true)

    renderHook(() => useAutoClearPrayerNotifications())

    expect(clearReminderNotifications).toHaveBeenCalledTimes(1)
    expect(snoozeReminders).toHaveBeenCalledWith('test-account')
  })

  it('only snoozes reminders once per day across multiple renders', () => {
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(true)

    const { rerender } = renderHook(() => useAutoClearPrayerNotifications())

    expect(clearReminderNotifications).toHaveBeenCalledTimes(1)
    expect(snoozeReminders).toHaveBeenCalledTimes(1)

    rerender()

    // clearReminderNotifications may run on updates, but snoozeReminders must only call once
    expect(snoozeReminders).toHaveBeenCalledTimes(1)
  })

  it('clears notifications without snoozing reminders if autoSnoozeWhenCompleted is false', () => {
    vi.mocked(useMetadata).mockReturnValue([false, vi.fn()])
    vi.mocked(isPrayerCompletedForToday).mockReturnValue(true)

    renderHook(() => useAutoClearPrayerNotifications())

    expect(clearReminderNotifications).toHaveBeenCalledTimes(1)
    expect(snoozeReminders).not.toHaveBeenCalled()
  })
})
