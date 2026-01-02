import { useMemo, useState } from 'react'
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
  const todayStr = new Date().toDateString()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => new Date(), [todayStr])
}

export function usePrevious<T>(value: T): T | undefined {
  const [state, setState] = useState<{ curr: T, prev: T | undefined }>({
    curr: value,
    prev: undefined,
  })

  if (state.curr !== value) {
    setState({
      curr: value,
      prev: state.curr,
    })
  }

  return state.prev
}

export function useStringMemo<T>(state: T[]): T[] {
  // Join strings if the array reference changes
  const key = useMemo(() => state.join('~'), [state])
  // Only change the returned array reference if the key changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => state, [key])
}

export function capitalise(name: string) {
  return name.charAt(0).toLocaleUpperCase() + name.slice(1)
}
