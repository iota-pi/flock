import { useLayoutEffect, useState } from 'react'

export function useSize(element: HTMLElement | null) {
  const [size, setSize] = useState<{ width: number, height: number } | undefined>(() => {
    if (element) {
      const { width, height } = element.getBoundingClientRect()
      return { width, height }
    }
    return undefined
  })

  useLayoutEffect(() => {
    if (!element) return

    // Observe resizing
    const resizeObserver = new ResizeObserver(entries => {
      entries.forEach(entry => {
        // Use getBoundingClientRect to ensure consistency with initial measurement and border-box sizing
        const { width, height } = entry.target.getBoundingClientRect()
        setSize({ width, height })
      })
    })

    resizeObserver.observe(element)

    // Check if size changed since render (e.g. layout shift)
    const rect = element.getBoundingClientRect()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSize(prev => {
      if (prev && prev.width === rect.width && prev.height === rect.height) return prev
      return { width: rect.width, height: rect.height }
    })

    return () => resizeObserver.disconnect()
  }, [element])

  return size
}
