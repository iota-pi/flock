import { Dispatch, SetStateAction, useEffect, useState } from 'react'
import type { DirtyItem, Item } from '../../../state/items'

type UsePrayerActiveViewPreloadOptions = {
  isOverview: boolean
  visibleCount: number
  buildLocalItems: (count: number) => DirtyItem<Item>[]
  setLocalItems: Dispatch<SetStateAction<DirtyItem<Item>[]>>
}

export default function usePrayerActiveViewPreload({
  isOverview,
  visibleCount,
  buildLocalItems,
  setLocalItems,
}: UsePrayerActiveViewPreloadOptions): boolean {
  const [preparedVisibleCount, setPreparedVisibleCount] = useState<number | null>(null)

  useEffect(
    () => {
      if (!isOverview) {
        return undefined
      }
      let cancelled = false

      const prepare = () => {
        if (cancelled) {
          return
        }

        setLocalItems(buildLocalItems(visibleCount))
        setPreparedVisibleCount(visibleCount)
      }

      const globalWindow = typeof window !== 'undefined' ? window : undefined
      if (globalWindow && 'requestIdleCallback' in globalWindow) {
        const idleId = globalWindow.requestIdleCallback(() => {
          prepare()
        }, { timeout: 250 })

        return () => {
          cancelled = true
          globalWindow.cancelIdleCallback?.(idleId)
        }
      }

      const timeoutId = globalThis.setTimeout(() => {
        prepare()
      }, 0)

      return () => {
        cancelled = true
        globalThis.clearTimeout(timeoutId)
      }
    },
    [buildLocalItems, isOverview, setLocalItems, visibleCount],
  )

  return isOverview && preparedVisibleCount === visibleCount
}