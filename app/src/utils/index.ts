import { MutableRefObject, useEffect, useMemo, useRef } from 'react'
import { v4 as uuidv4 } from 'uuid'

export type MostlyRequired<T> = { [K in keyof Required<T>]: T[K] }

export const APP_NAME = 'Flock'

export function isDefined<T>(x: T | null | undefined): x is Exclude<T, null | undefined> {
  return x !== undefined && x !== null
}

export function generateItemId() {
  return uuidv4()
}

export function formatDate(date: Date) {
  return date.toLocaleDateString()
}

export function formatTime(date: Date) {
  const hours = ((date.getHours() % 12) + 1) || 12
  const minutes = date.getMinutes().toString().padStart(2, '0')
  const amPm = date.getHours() < 12 ? 'am' : 'pm'
  return `${hours}:${minutes}${amPm}`
}

export function formatDateAndTime(date: Date) {
  return `${formatDate(date)} ${formatTime(date)}`
}

export function isSameDay(d1: Date, d2: Date) {
  return formatDate(d1) === formatDate(d2)
}

export function useToday() {
  const d = useRef(new Date())
  if (!isSameDay(d.current, new Date())) {
    d.current = new Date()
  }
  return d.current
}

export function usePreviousRef<T>(state: T): MutableRefObject<T | undefined> {
  const ref = useRef<T>()
  useEffect(() => {
    ref.current = state
  })
  return ref
}

export function usePrevious<T>(state: T): T | undefined {
  const ref = usePreviousRef<T>(state)
  return ref.current
}

export function useStringMemo<T>(state: T[]): T[] {
  const prev = useRef<T[]>(state)
  const prevKey = useRef<string>('')
  return useMemo(
    () => {
      const sep = '~'
      const key = state.join(sep)
      if (!prev.current || prevKey.current !== key) {
        prev.current = state
        prevKey.current = key
      }
      return prev.current
    },
    [prev, prevKey, state],
  )
}

export function capitalise(name: string) {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1)
}
