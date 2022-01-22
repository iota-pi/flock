import { useEffect, useRef } from 'react';
import { VariableSizeList } from 'react-window';

export function useResetCache<T = any>(data: any) {
  const ref = useRef<VariableSizeList<T>>(null);
  useEffect(
    () => {
      if (ref.current !== null) {
        ref.current.resetAfterIndex(0, true);
      }
    },
    [data],
  );
  return ref;
}

export default useResetCache;
