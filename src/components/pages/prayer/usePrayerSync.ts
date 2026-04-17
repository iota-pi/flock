import { useCallback } from 'react'
import { storeItems } from '../../../features/items/mutations/itemMutations'
import {
  isItem,
  isValid,
  Item,
  LocalChangeItem,
  stripLocalItemState,
} from '../../../state/items'

type PrayerSyncController = {
  queuePrayedForSync: (item: LocalChangeItem<Item>) => void
  saveLocalItem: (item: LocalChangeItem<Item>) => void
}

export default function usePrayerSync(): PrayerSyncController {
  const persistLocalItem = useCallback(
    (currentItem: LocalChangeItem<Item>) => {
      if ((currentItem.hasLocalChanges || currentItem.isNew) && isValid(currentItem)) {
        const clean = stripLocalItemState(currentItem)
        if (isItem(clean)) {
          void storeItems(clean).catch(error => {
            console.error(error)
          })
        }
      }
    },
    [],
  )

  return {
    queuePrayedForSync: persistLocalItem,
    saveLocalItem: persistLocalItem,
  }
}