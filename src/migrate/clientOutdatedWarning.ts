let warning: string | null = null
const listeners = new Set<() => void>()

/** Kept apart from the migration bridge because `setup.ts` runs before any vault code loads */
export function setClientOutdatedWarning(message: string): void {
  warning = message
  for (const listener of listeners) {
    listener()
  }
}

/** For `useSyncExternalStore` */
export function subscribeClientOutdatedWarning(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getClientOutdatedWarning(): string | null {
  return warning
}
