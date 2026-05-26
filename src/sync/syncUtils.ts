export type DebouncedNotifier = {
  schedule: () => void
  cancel: () => void
}

export function createDebouncedNotifier(callback: () => void, debounceMs: number): DebouncedNotifier {
  let timeoutId: ReturnType<typeof setTimeout> | null = null

  const schedule = () => {
    if (timeoutId !== null) {
      return
    }

    timeoutId = setTimeout(() => {
      timeoutId = null
      callback()
    }, debounceMs)
  }

  const cancel = () => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
  }

  return {
    schedule,
    cancel,
  }
}
