export type AppEvent =
  | {
    type: 'data:updated'
    domain: string
    reason?: string
  }

type AppEventListener = (event: AppEvent) => void

const listeners = new Set<AppEventListener>()

export function emitAppEvent(event: AppEvent): void {
  for (const listener of listeners) {
    listener(event)
  }
}

export function subscribeAppEvents(listener: AppEventListener): () => void {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}
