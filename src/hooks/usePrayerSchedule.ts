import { useCallback, useEffect, useMemo, useState } from 'react'
import { useToday } from './useToday'
import { useItemMap, useItems, useMetadata } from '../state/selectors'
import { isSameDay, useStringMemo } from '../utils'
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../utils/prayer'
import { Item } from '../state/items'
import { useStoreItemsMutation } from '../api/queries'

export function usePrayerSchedule() {
  const items = useItems()
  const itemMap = useItemMap()
  const today = useToday()

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)
  const [todaysGoal, setTodaysGoal] = useState(goal)

  const { mutate: storeItems } = useStoreItemsMutation()

  useEffect(() => {
    setTodaysGoal(goal)
  }, [goal])

  const isPrayedForToday = useCallback(
    (item: Item): boolean => isSameDay(today, new Date(getLastPrayedFor(item))),
    [today],
  )

  const rawPrayerSchedule = useMemo(
    () => getPrayerSchedule(items),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // Force prayer schedule to update on a new day
    [items, today],
  )
  const scheduleIds = useStringMemo(rawPrayerSchedule)

  const schedule = useMemo(
    () => scheduleIds.map(id => itemMap[id]),
    [itemMap, scheduleIds],
  )

  const visibleSchedule = useMemo(
    () => schedule.slice(0, todaysGoal),
    [todaysGoal, schedule],
  )

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
      const newItem: Item = { ...item, prayedFor }
      storeItems(newItem)
    },
    [isPrayedForToday, storeItems],
  )

  const showMore = useCallback(() => {
    setTodaysGoal(g => g + 3)
  }, [])

  return {
    completed,
    goal,
    isPrayedForToday,
    naturalGoal,
    recordPrayerFor,
    scheduleIds,
    showMore,
    visibleSchedule,
  }
}
