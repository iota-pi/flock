import { useCallback, useLayoutEffect, useRef } from 'react'

/**
 * A hook that returns a stable callback reference, which always has access to
 * the latest state and props without triggering re-renders when they change.
 * Useful for optimizing callbacks passed to memoized children.
 */
export function useEventCallback<Args extends unknown[], Return>(
  fn: (...args: Args) => Return,
): (...args: Args) => Return {
  const ref = useRef(fn)

  useLayoutEffect(() => {
    ref.current = fn
  })

  return useCallback((...args: Args) => {
    return ref.current(...args)
  }, [])
}
