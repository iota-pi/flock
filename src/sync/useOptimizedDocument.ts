import { useCallback, useMemo, useRef, useSyncExternalStore } from 'react'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl, DocHandle } from '@automerge/automerge-repo/slim'

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined
export type Repo = ReturnType<typeof useRepo>
export type OptimizedDocumentEvent = 'change' | 'heads-changed' | 'delete'

export type StableSnapshot<T> = {
  signature: string
  value: T
}

function findRepoDocHandle<TDoc extends object>(repo: Repo, documentUrl: AutomergeUrl): DocHandle<TDoc> | undefined {
  try {
    return repo.findWithProgress<TDoc>(documentUrl).handle as DocHandle<TDoc>
  } catch {
    return undefined
  }
}

function readReadySnapshot(handle: RepoDocHandle): RepoDoc | null {
  if (!handle || !handle.isReady() || handle.isUnavailable()) {
    return null
  }

  try {
    const doc = handle.doc()
    return (!doc || typeof doc !== 'object' || Array.isArray(doc)) ? null : (doc as RepoDoc)
  } catch {
    return null
  }
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value)
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))

    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableSerialize(entryValue)}`).join(',')}}`
  }

  return JSON.stringify(String(value))
}

export function readStableSnapshot<T>(
  value: T,
  snapshotRef: { current: StableSnapshot<T> | null },
): T {
  const signature = stableSerialize(value)

  if (snapshotRef.current?.signature === signature) {
    return snapshotRef.current.value
  }

  snapshotRef.current = {
    signature,
    value,
  }

  return value
}

const DEFAULT_DOCUMENT_EVENTS: ReadonlyArray<OptimizedDocumentEvent> = ['change', 'heads-changed']

export function useOptimizedDocument<TDoc extends object, TSnapshot>(
  documentUrl: AutomergeUrl | null | undefined,
  projectSnapshot: (doc: TDoc | undefined) => TSnapshot,
  fallbackSnapshot: TSnapshot,
  eventNames: ReadonlyArray<OptimizedDocumentEvent> = DEFAULT_DOCUMENT_EVENTS,
  debounceMs = 50,
): readonly [TSnapshot, (changeFn: (draft: TDoc) => void) => void, DocHandle<TDoc> | undefined] {
  const repo = useRepo()

  const handle = useMemo(
    () => (documentUrl ? findRepoDocHandle<TDoc>(repo, documentUrl) : undefined),
    [repo, documentUrl],
  )

  const snapshotRef = useRef<StableSnapshot<TSnapshot> | null>(null)
  const lastDocRef = useRef<TDoc | undefined>(undefined)

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!handle) {
        return () => {}
      }

      let timeoutId: ReturnType<typeof setTimeout> | null = null

      const batchedChange = () => {
        if (timeoutId !== null) {
          return
        }

        timeoutId = setTimeout(() => {
          timeoutId = null
          onStoreChange()
        }, debounceMs)
      }

      for (const eventName of eventNames) {
        handle.on(eventName, batchedChange)
      }

      return () => {
        if (timeoutId !== null) {
          clearTimeout(timeoutId)
        }

        for (const eventName of eventNames) {
          handle.removeListener(eventName, batchedChange)
        }
      }
    },
    [debounceMs, eventNames, handle],
  )

  const getSnapshot = useCallback(
    (): TSnapshot => {
      if (!handle || handle.isUnavailable()) {
        return readStableSnapshot(fallbackSnapshot, snapshotRef)
      }

      if (!handle.isReady()) {
        throw handle.whenReady()
      }

      let currentDoc: TDoc | undefined
      try {
        currentDoc = handle.doc()
      } catch {
        currentDoc = undefined
      }

      if (currentDoc === lastDocRef.current && snapshotRef.current) {
        return snapshotRef.current.value
      }

      lastDocRef.current = currentDoc
      return readStableSnapshot(projectSnapshot(currentDoc), snapshotRef)
    },
    [fallbackSnapshot, handle, projectSnapshot],
  )

  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => fallbackSnapshot,
  )

  const changeDoc = useCallback(
    (changeFn: (draft: TDoc) => void) => {
      if (!handle || !handle.isReady() || handle.isUnavailable()) {
        return
      }

      handle.change(changeFn)
    },
    [handle],
  )

  return [snapshot, changeDoc, handle] as const
}

export { findRepoDocHandle, readReadySnapshot }
