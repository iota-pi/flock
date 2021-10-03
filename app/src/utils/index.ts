import { useEffect, useMemo, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';

export const APP_NAME = 'Flock';

export function getAccountId() {
  return uuidv4();
}

export function getItemId() {
  return uuidv4();
}

export function formatDate(date: Date) {
  return date.toLocaleDateString();
}

export function formatTime(date: Date) {
  const hours = ((date.getHours() % 12) + 1) || 12;
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const amPm = date.getHours() < 12 ? 'am' : 'pm';
  return `${hours}:${minutes}${amPm}`;
}

export function formatDateAndTime(date: Date) {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function isSameDay(d1: Date, d2: Date) {
  return formatDate(d1) === formatDate(d2);
}

export function usePrevious<T>(state: T): T | undefined {
  const ref = useRef<T>();
  useEffect(() => {
    ref.current = state;
  });
  return ref.current;
}

export function useStringMemo<T>(state: T[]): T[] {
  const prev = useRef<T[]>(state);
  const prevKey = useRef<string>('');
  return useMemo(
    () => {
      const sep = '~~~';
      const key = state.join(sep);
      if (!prev.current || prevKey.current !== key) {
        prev.current = state;
        prevKey.current = key;
      }
      return prev.current;
    },
    [prev, state],
  );
}
