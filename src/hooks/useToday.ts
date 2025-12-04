import { useSyncExternalStore } from 'react'

const CHECK_INTERVAL_MS = 1000

export function getStartOfDay(date = new Date()): Date {
  const result = new Date(date)
  result.setHours(0, 0, 0, 0)
  return result
}

// Shared state for all subscribers
let currentToday = getStartOfDay()
const listeners = new Set<() => void>()

function notifyListeners() {
  listeners.forEach(listener => listener())
}

function subscribe(callback: () => void): () => void {
  // Start the interval when first subscriber connects
  if (listeners.size === 0) {
    startInterval()
  }
  listeners.add(callback)

  return () => {
    listeners.delete(callback)
    // Stop the interval when last subscriber disconnects
    if (listeners.size === 0) {
      stopInterval()
    }
  }
}

function getSnapshot(): Date {
  return currentToday
}

let intervalId: ReturnType<typeof setInterval> | null = null

function startInterval() {
  if (intervalId !== null) return

  intervalId = setInterval(() => {
    const now = getStartOfDay()
    if (now.getTime() !== currentToday.getTime()) {
      currentToday = now
      notifyListeners()
    }
  }, CHECK_INTERVAL_MS)
}

function stopInterval() {
  if (intervalId !== null) {
    clearInterval(intervalId)
    intervalId = null
  }
}

/**
 * Returns the current date (at midnight) and updates automatically when the day changes.
 * All uses of this hook share a single interval timer.
 */
export function useToday(): Date {
  return useSyncExternalStore(subscribe, getSnapshot)
}

// Export internals for testing
export const __test__ = {
  subscribe,
  getSnapshot,
  reset: () => {
    stopInterval()
    listeners.clear()
    currentToday = getStartOfDay()
  },
  getListenerCount: () => listeners.size,
}
