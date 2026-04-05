import { useEffect, useState } from 'react'
import { isEqual } from 'lodash-es'

export function useStableDeepValue<T>(value: T): T {
  const [stableValue, setStableValue] = useState(value)

  useEffect(() => {
    if (!isEqual(stableValue, value)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStableValue(value)
    }
  }, [stableValue, value])

  return stableValue
}
