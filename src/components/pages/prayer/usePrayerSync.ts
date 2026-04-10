import { useCallback, useEffect, useMemo } from 'react'
import { storeItems } from '../../../features/items/mutations/itemMutations'
import {
  cleanItem,
  DirtyItem,
  isItem,
  isValid,
  Item,
} from '../../../state/items'
import { createDebouncedByKey } from '../../../utils/debounceByKey'

type PrayerSyncController = {
  queuePrayedForSync: (item: DirtyItem<Item>) => void
  saveLocalItem: (item: DirtyItem<Item>) => void
}

export default function usePrayerSync(): PrayerSyncController {
  const prayedSyncQueue = useMemo(
    () => createDebouncedByKey<string, Item>(500, latestItem => {
      storeItems(latestItem)
    }),
    [],
  )

  useEffect(
    () => () => prayedSyncQueue.clear(),
    [prayedSyncQueue],
  )

  const saveLocalItem = useCallback(
    (currentItem: DirtyItem<Item>) => {
      if ((currentItem.dirty || currentItem.isNew) && isValid(currentItem)) {
        const clean = cleanItem(currentItem)
        if (isItem(clean)) {
          storeItems(clean)
        }
      }
    },
    [],
  )

  const queuePrayedForSync = useCallback(
    (currentItem: DirtyItem<Item>) => {
      const clean = cleanItem(currentItem)
      if (!isItem(clean) || !isValid(clean)) {
        return
      }

      prayedSyncQueue.schedule(clean.id, clean)
    },
    [prayedSyncQueue],
  )

  return {
    queuePrayedForSync,
    saveLocalItem,
  }
}