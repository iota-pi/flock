import { useEffect, useRef } from 'react'
import { useLoggedIn, usePrayerScheduleInputs, useMetadata } from '../state/selectors'
import { useAppStore } from '../state/store'
import { useToday } from './useToday'
import { isPrayerCompletedForToday } from '../utils/prayer'
import { clearReminderNotifications } from '../utils/pushNotifications'
import { snoozeReminders } from '../api/vault'
import { formatDate } from '../utils'

export function useAutoClearPrayerNotifications(): void {
  const loggedIn = useLoggedIn()
  const account = useAppStore(state => state.account)
  const dataStatus = useAppStore(state => state.dataStatus)
  const { items, prayerGoal } = usePrayerScheduleInputs()
  const today = useToday()
  const [autoSnoozeWhenCompleted = true] = useMetadata('autoSnoozeWhenCompleted', true)

  const lastSnoozedDateRef = useRef<string | null>(null)

  useEffect(() => {
    if (!loggedIn || !account || dataStatus !== 'ready') {
      return
    }

    const isCompleted = isPrayerCompletedForToday(items, prayerGoal, today)
    if (!isCompleted) {
      return
    }

    void clearReminderNotifications()

    const todayStr = formatDate(today)
    if (autoSnoozeWhenCompleted && lastSnoozedDateRef.current !== todayStr) {
      lastSnoozedDateRef.current = todayStr
      void snoozeReminders(account).catch(err => {
        console.warn('Failed to auto-snooze reminders after prayer completion:', err)
      })
    }
  }, [
    account,
    autoSnoozeWhenCompleted,
    dataStatus,
    items,
    loggedIn,
    prayerGoal,
    today,
  ])
}
