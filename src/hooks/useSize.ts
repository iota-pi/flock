import { useLayoutEffect, useState, RefObject } from 'react'

export function useSize(target: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<{ width: number, height: number }>()

  useLayoutEffect(() => {
    if (!target.current) return
    const element = target.current

    const resizeObserver = new ResizeObserver(entries => {
      entries.forEach(entry => {
        setSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        })
      })
    })

    resizeObserver.observe(element)
    return () => resizeObserver.disconnect()
  }, [target])

  return size
}
