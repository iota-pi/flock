import { useCallback, useMemo, useState } from 'react'
import { useToday } from './useToday'
import { usePrayerScheduleInputs } from '../state/selectors'
import { useStableArray } from '../utils'
import {
  getNaturalPrayerGoal,
  getPrayerSchedule,
  isPrayedForToday as isItemPrayedForToday,
  togglePrayedForToday,
} from '../utils/prayer'
import type { Item } from '../state/items'
import { mutateItem } from 'src/features/items/mutations/itemMutations'

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
  const [prevGoal, setPrevGoal] = useState(goal)

  if (goal !== prevGoal) {
    setPrevGoal(goal)
    setTodaysGoal(goal)
  }

  const isPrayedForToday = useCallback(
    (item: Item): boolean => isItemPrayedForToday(item, today),
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

  const visibleScheduleIds = useMemo(
    () => scheduleIds.slice(0, todaysGoal),
    [todaysGoal, scheduleIds],
  )

  const completed = useMemo(
    () => items.filter(isPrayedForToday).length,
    [items, isPrayedForToday],
  )

  const recordPrayerFor = useCallback(
    (item: Item, toggle = false) => {
      const prayedFor = toggle || !isPrayedForToday(item)
        ? togglePrayedForToday(item)
        : item.prayedFor

      void mutateItem(item.id, { prayedFor })
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
    visibleScheduleIds,
  }
}
