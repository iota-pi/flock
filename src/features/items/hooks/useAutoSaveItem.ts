import { useCallback, useEffect, useRef, useState } from 'react'
import {
  cleanItem,
  DirtyItem,
  isItem,
  isValid,
  Item,
} from '../../../state/items'
import { usePrevious } from '../../../utils'

type UseAutoSaveItemOptions = {
  item: DirtyItem<Item>
  onPersist: (item: Item) => void
  open: boolean
  autoSaveDelayMs?: number
}

type SaveOptions = {
  disableFutureAutoSave?: boolean
}

type UseAutoSaveItemResult = {
  disableAutoSaveNow: () => void
  enableAutoSaveNow: () => void
  saveItem: (itemToSave: DirtyItem<Item>, options?: SaveOptions) => Item | undefined
}

export default function useAutoSaveItem({
  item,
  onPersist,
  open,
  autoSaveDelayMs = 10000,
}: UseAutoSaveItemOptions): UseAutoSaveItemResult {
  const [disableAutoSave, setDisableAutoSave] = useState(false)
  const prevItem = usePrevious(item)

  const itemRef = useRef(item)
  const disableAutoSaveRef = useRef(disableAutoSave)

  useEffect(() => {
    itemRef.current = item
  }, [item])

  useEffect(() => {
    disableAutoSaveRef.current = disableAutoSave
  }, [disableAutoSave])

  const persistItem = useCallback(
    (itemToSave: DirtyItem<Item>): Item | undefined => {
      if ((itemToSave.dirty || itemToSave.isNew) && isValid(itemToSave)) {
        const clean = cleanItem(itemToSave)
        if (isItem(clean)) {
          onPersist(clean)
        }

        return clean
      }

      return undefined
    },
    [onPersist],
  )

  const saveItem = useCallback(
    (itemToSave: DirtyItem<Item>, options: SaveOptions = {}): Item | undefined => {
      const clean = persistItem(itemToSave)
      if (clean) {
        if (options.disableFutureAutoSave !== false) {
          setDisableAutoSave(true)
        }

        return clean
      }

      return undefined
    },
    [persistItem],
  )

  const disableAutoSaveNow = useCallback(() => {
    setDisableAutoSave(true)
  }, [])

  const enableAutoSaveNow = useCallback(() => {
    setDisableAutoSave(false)
  }, [])

  useEffect(
    () => {
      if (open && prevItem && prevItem.id !== item.id) {
        persistItem(prevItem)
      }
    },
    [item.id, open, persistItem, prevItem],
  )

  useEffect(
    () => {
      if (!disableAutoSave && item.dirty && !item.isNew) {
        const timeout = setTimeout(
          () => saveItem(item),
          autoSaveDelayMs,
        )

        return () => clearTimeout(timeout)
      }

      return undefined
    },
    [autoSaveDelayMs, disableAutoSave, item, saveItem],
  )

  const saveItemRef = useRef(saveItem)
  useEffect(() => {
    saveItemRef.current = saveItem
  }, [saveItem])

  useEffect(
    () => () => {
      if (!disableAutoSaveRef.current) {
        saveItemRef.current(itemRef.current, { disableFutureAutoSave: false })
      }
    },
    [],
  )

  return {
    disableAutoSaveNow,
    enableAutoSaveNow,
    saveItem,
  }
}