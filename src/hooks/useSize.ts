import type { RefObject } from 'react'
import { useMemo } from 'react'
import { useResizeObserver } from 'usehooks-ts'

export function useSize(element: HTMLElement | null) {
  const ref = useMemo(() => ({ current: element }) as RefObject<HTMLElement>, [element])
  const observed = useResizeObserver({ ref })

  if (!element) {
    return undefined
  }

  if (typeof observed.width === 'number' && typeof observed.height === 'number') {
    return {
      width: observed.width,
      height: observed.height,
    }
  }

  const rect = element.getBoundingClientRect()
  return {
    width: rect.width,
    height: rect.height,
  }
}
