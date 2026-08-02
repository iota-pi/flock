import { nanoid } from 'nanoid'
import { useEffect, useRef } from 'react'
import type { ItemId } from 'src/shared/schemas/items'

export const APP_NAME = 'Flock'

export function isDefined<T>(x: T | null | undefined): x is Exclude<T, null | undefined> {
  return x !== undefined && x !== null
}

export function generateItemId() {
  return nanoid() as ItemId
}

export function formatDate(date: Date) {
  return date.toLocaleDateString()
}

export function isSameDay(d1: Date, d2: Date) {
  return formatDate(d1) === formatDate(d2)
}

export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>(undefined)

  useEffect(() => {
    ref.current = value
  })

  // eslint-disable-next-line react-hooks/refs
  return ref.current
}

/* eslint-disable react-hooks/refs */
export function useStableArray<T>(array: T[]): T[] {
  const ref = useRef<T[]>(array)

  const current = ref.current
  let isSame = current.length === array.length

  if (isSame) {
    for (let i = 0; i < array.length; i++) {
      if (current[i] !== array[i]) {
        isSame = false
        break
      }
    }
  }

  if (!isSame) {
    ref.current = array
  }

  return ref.current
}
/* eslint-enable react-hooks/refs */
