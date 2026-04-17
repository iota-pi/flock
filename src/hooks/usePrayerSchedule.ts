import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToday } from './useToday'
import { usePrayerScheduleInputs } from '../state/selectors'
import { isSameDay, useStableArray } from '../utils'
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../utils/prayer'
import { Item } from '../state/items'
import { withAutomergeDocumentChange } from '../sync/automergeDocStore'

export function usePrayerSchedule() {
  const {
    items,
    prayerGoal,
  } = usePrayerScheduleInputs()
  const today = useToday()

  const itemMap = useMemo(
    () => Object.fromEntries(items.map(item => [item.id, item])),
    [items],
  )

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const goal = prayerGoal ?? naturalGoal
  const [todaysGoal, setTodaysGoal] = useState(goal)

  useEffect(() => {
    setTodaysGoal(goal)
  }, [goal])

  const isPrayedForToday = useCallback(
    (item: Item): boolean => isSameDay(today, new Date(getLastPrayedFor(item))),
    [today],
  )

  const rawPrayerSchedule = useMemo(
    () => getPrayerSchedule(items),
    // Force prayer schedule to update on a new day
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, today],
  )
  const scheduleIds = useStableArray(rawPrayerSchedule)

  const rawSchedule = useMemo(
    () => scheduleIds
      .map(id => itemMap[id])
      .filter((item): item is Item => !!item),
    [itemMap, scheduleIds],
  )
  const schedule = useStableArray(rawSchedule)

  const rawVisibleSchedule = useMemo(
    () => schedule.slice(0, todaysGoal),
    [todaysGoal, schedule],
  )
  const visibleSchedule = useStableArray(rawVisibleSchedule)

  const completed = useMemo(
    () => items.filter(isPrayedForToday).length,
    [items, isPrayedForToday],
  )

  const recordPrayerFor = useCallback(
    (item: Item, toggle = false) => {
      let prayedFor = item.prayedFor
      if (isPrayedForToday(item)) {
        if (toggle) {
          const startOfDay = new Date()
          startOfDay.setHours(0, 0, 0, 0)
          prayedFor = prayedFor.filter(d => d < startOfDay.getTime())
        }
      } else {
        prayedFor = [...prayedFor, new Date().getTime()]
      }

      void withAutomergeDocumentChange(
        item.id,
        doc => {
          doc.prayedFor = prayedFor
          if (typeof doc.id !== 'string' || doc.id.length === 0) {
            doc.id = item.id
          }
        },
        {
          createIfMissing: true,
          initialValue: { id: item.id },
        },
      )
    },
    [isPrayedForToday],
  )

  const showMore = useCallback(() => {
    setTodaysGoal(g => g + 3)
  }, [])

  const showUntil = useCallback((newCount: number) => {
    setTodaysGoal(g => Math.max(g, newCount))
  }, [])

  return {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    schedule,
    scheduleIds,
    showMore,
    showUntil,
    visibleSchedule,
  }
}
