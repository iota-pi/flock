import { ReactNode, useEffect, useState } from 'react'


interface DelayedRenderProps {
  children: ReactNode
  delayMs?: number
  fallback?: ReactNode
}

function DelayedRender({
  children,
  delayMs = 100,
  fallback = null,
}: DelayedRenderProps) {
  const [shouldRender, setShouldRender] = useState(delayMs <= 0)

  useEffect(() => {
    if (shouldRender) {
      return
    }

    const timeoutId = setTimeout(() => {
      setShouldRender(true)
    }, Math.max(delayMs, 0))

    return () => {
      clearTimeout(timeoutId)
    }
  }, [delayMs, shouldRender])

  if (!shouldRender || !children) {
    return <>{fallback}</>
  }

  return <>{children}</>
}

export default DelayedRender