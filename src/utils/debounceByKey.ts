import debounce from '@mui/utils/debounce'

type DebouncedFunction<TValue> = ((value: TValue) => void) & { clear: () => void }

export type DebouncedByKey<TKey, TValue> = {
  schedule: (key: TKey, value: TValue) => void
  clear: () => void
  clearKey: (key: TKey) => void
}

export function createDebouncedByKey<TKey, TValue>(
  delayMs: number,
  callback: (value: TValue) => void,
): DebouncedByKey<TKey, TValue> {
  const debouncedByKey = new Map<TKey, DebouncedFunction<TValue>>()

  return {
    schedule: (key, value) => {
      let debounced = debouncedByKey.get(key)
      if (!debounced) {
        debounced = debounce((latestValue: TValue) => {
          callback(latestValue)
          debouncedByKey.delete(key)
        }, delayMs) as DebouncedFunction<TValue>
        debouncedByKey.set(key, debounced)
      }
      debounced(value)
    },
    clear: () => {
      for (const debounced of debouncedByKey.values()) {
        debounced.clear()
      }
      debouncedByKey.clear()
    },
    clearKey: key => {
      const debounced = debouncedByKey.get(key)
      debounced?.clear()
      debouncedByKey.delete(key)
    },
  }
}
