/* eslint-disable react-hooks/refs */
import { useRef } from 'react'

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }

  if (left instanceof Map && right instanceof Map) {
    if (left.size !== right.size) {
      return false
    }

    for (const [key, value] of left.entries()) {
      if (!right.has(key) || !deepEqual(value, right.get(key))) {
        return false
      }
    }

    return true
  }

  if (left instanceof Set && right instanceof Set) {
    if (left.size !== right.size) {
      return false
    }

    for (const value of left.values()) {
      if (!right.has(value)) {
        return false
      }
    }

    return true
  }

  if (!isObject(left) || !isObject(right)) {
    return false
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqual(left[index], right[index])) {
        return false
      }
    }

    return true
  }

  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)

  if (leftKeys.length !== rightKeys.length) {
    return false
  }

  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return false
    }

    if (!deepEqual(left[key], right[key])) {
      return false
    }
  }

  return true
}

export function useDeepCompareMemo<T>(value: T): T {
  const ref = useRef(value)

  if (!deepEqual(ref.current, value)) {
    ref.current = value
  }

  return ref.current
}
