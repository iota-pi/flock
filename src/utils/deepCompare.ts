/* eslint-disable react-hooks/refs */
import { useRef } from 'react'
import { isEqual } from 'lodash-es'

export function deepEqual(left: unknown, right: unknown): boolean {
  return isEqual(left, right)
}

export function useDeepCompareMemo<T>(value: T): T {
  const ref = useRef(value)

  if (!deepEqual(ref.current, value)) {
    ref.current = value
  }

  return ref.current
}
