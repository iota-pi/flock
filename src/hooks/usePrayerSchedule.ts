import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useToday } from './useToday'
import { useItemMap, useItems, useMetadata } from '../state/selectors'
import { isSameDay, useStringMemo } from '../utils'
import { getLastPrayedFor, getNaturalPrayerGoal, getPrayerSchedule } from '../utils/prayer'
import { Item } from '../state/items'
import { useStoreItemsMutation } from '../api/queries'
import { queryClient, queryKeys } from '../api/queryClient'

export function usePrayerSchedule() {
  const items = useItems()
  const itemMap = useItemMap()
  const today = useToday()

  const naturalGoal = useMemo(() => getNaturalPrayerGoal(items), [items])
  const [goal] = useMetadata('prayerGoal', naturalGoal)
  const [todaysGoal, setTodaysGoal] = useState(goal)

  const { mutate: storeItems } = useStoreItemsMutation({ invalidateOnSettled: false })
  const prayerSyncTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const prayerSyncItemsRef = useRef<Map<string, Item>>(new Map())

  useEffect(
    () => () => {
      for (const timeoutId of prayerSyncTimersRef.current.values()) {
        globalThis.clearTimeout(timeoutId)
      }
      prayerSyncTimersRef.current.clear()
      prayerSyncItemsRef.current.clear()
    },
    [],
  )

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

      // Update cache immediately for responsive UI, then debounce server sync.
      queryClient.setQueryData<Item[]>(
        queryKeys.items,
        oldItems => {
          if (!oldItems) return [newItem]
          const index = oldItems.findIndex(existing => existing.id === newItem.id)
          if (index < 0) {
            return [...oldItems, newItem]
          }
          const next = [...oldItems]
          next[index] = newItem
          return next
        },
      )

      prayerSyncItemsRef.current.set(newItem.id, newItem)
      const existingTimeout = prayerSyncTimersRef.current.get(newItem.id)
      if (existingTimeout !== undefined) {
        globalThis.clearTimeout(existingTimeout)
      }

      const timeoutId = globalThis.setTimeout(() => {
        const latestItem = prayerSyncItemsRef.current.get(newItem.id)
        if (latestItem) {
          storeItems(latestItem)
        }
        prayerSyncTimersRef.current.delete(newItem.id)
        prayerSyncItemsRef.current.delete(newItem.id)
      }, 500)

      prayerSyncTimersRef.current.set(newItem.id, timeoutId)
    },
    [isPrayedForToday, storeItems],
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
