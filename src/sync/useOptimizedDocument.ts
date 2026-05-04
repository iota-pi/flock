import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { useRepo } from '@automerge/automerge-repo-react-hooks'
import type { AutomergeUrl, DocHandle } from '@automerge/automerge-repo/slim'
import deepEqual from 'fast-deep-equal'
import { createDebouncedNotifier } from './syncUtils'
import {
  findRepoDocHandle,
  readHandleDocSafely,
  readReadyObjectSnapshot,
} from './automergeHandleUtils'
import { useSyncStore } from '../state/syncStore'

export type RepoDoc = Record<string, unknown>
export type RepoDocHandle = DocHandle<RepoDoc> | undefined
export type Repo = ReturnType<typeof useRepo>
export type OptimizedDocumentEvent = 'change' | 'heads-changed' | 'delete'

type OptimizedDocumentStore<TDoc extends object, TSnapshot> = {
  handle: DocHandle<TDoc> | undefined
  projectSnapshot: (doc: TDoc | undefined) => TSnapshot
  fallbackSnapshot: TSnapshot
  currentDoc: TDoc | undefined
  currentSnapshot: TSnapshot
  snapshotByDocRef: WeakMap<object, TSnapshot>
}

const readReadySnapshot = (handle: RepoDocHandle): RepoDoc | null => readReadyObjectSnapshot(handle)

function readProjectedSnapshot<TDoc extends object, TSnapshot>(
  store: OptimizedDocumentStore<TDoc, TSnapshot>,
  doc: TDoc | undefined,
): TSnapshot {
  if (!doc || typeof doc !== 'object') {
    return store.projectSnapshot(doc)
  }

  const cacheKey = doc as object
  if (store.snapshotByDocRef.has(cacheKey)) {
    return store.snapshotByDocRef.get(cacheKey) as TSnapshot
  }

  const snapshot = store.projectSnapshot(doc)
  store.snapshotByDocRef.set(cacheKey, snapshot)
  return snapshot
}

function syncStoreSnapshotFromHandle<TDoc extends object, TSnapshot>(
  store: OptimizedDocumentStore<TDoc, TSnapshot>,
): boolean {
  const currentHandle = store.handle

  if (!currentHandle || currentHandle.isUnavailable()) {
    const nextSnapshot = deepEqual(store.currentSnapshot, store.fallbackSnapshot)
      ? store.currentSnapshot
      : store.fallbackSnapshot
    const hasChanged = (store.currentDoc !== undefined) || (nextSnapshot !== store.currentSnapshot)
    store.currentDoc = undefined
    store.currentSnapshot = nextSnapshot
    return hasChanged
  }

  if (!currentHandle.isReady()) {
    const nextSnapshot = deepEqual(store.currentSnapshot, store.fallbackSnapshot)
      ? store.currentSnapshot
      : store.fallbackSnapshot
    const hasChanged = (store.currentDoc !== undefined) || (nextSnapshot !== store.currentSnapshot)
    store.currentDoc = undefined
    store.currentSnapshot = nextSnapshot
    return hasChanged
  }

  const nextDoc = readHandleDocSafely(currentHandle)
  if (nextDoc === store.currentDoc) {
    return false
  }

  store.currentDoc = nextDoc
  const nextSnapshot = readProjectedSnapshot(store, nextDoc)

  if (deepEqual(nextSnapshot, store.currentSnapshot)) {
    return false
  }

  store.currentSnapshot = nextSnapshot
  return true
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
  const syncGeneration = useSyncStore(state => state.generation)

  const handle = useMemo(
    () => (documentUrl ? findRepoDocHandle<TDoc>(repo, documentUrl) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repo, documentUrl, syncGeneration],
  )

  const store = useMemo((): OptimizedDocumentStore<TDoc, TSnapshot> => {
    const nextStore: OptimizedDocumentStore<TDoc, TSnapshot> = {
      handle,
      projectSnapshot,
      fallbackSnapshot,
      currentDoc: undefined,
      currentSnapshot: fallbackSnapshot,
      snapshotByDocRef: new WeakMap<object, TSnapshot>(),
    }

    syncStoreSnapshotFromHandle(nextStore)
    return nextStore
  }, [fallbackSnapshot, handle, projectSnapshot])

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!handle) {
        return () => {}
      }

      const debounced = createDebouncedNotifier(() => {
        const didChange = syncStoreSnapshotFromHandle(store)
        if (didChange) {
          onStoreChange()
        }
      }, debounceMs)

      for (const eventName of eventNames) {
        handle.on(eventName, debounced.schedule)
      }

      return () => {
        debounced.cancel()

        for (const eventName of eventNames) {
          handle.removeListener(eventName, debounced.schedule)
        }
      }
    },
    [debounceMs, eventNames, handle, store],
  )

  const getSnapshot = useCallback(
    (): TSnapshot => {
      const currentHandle = store.handle

      if (currentHandle && !currentHandle.isUnavailable() && !currentHandle.isReady()) {
        const isDeleted = (
          currentHandle.state === 'deleted'
          || (typeof (currentHandle as unknown as Record<string, unknown>).isDeleted === 'function' && (currentHandle as unknown as { isDeleted: () => boolean }).isDeleted())
        )
        
        if (!isDeleted) {
          throw currentHandle.whenReady()
        }
      }

      return store.currentSnapshot
    },
    [store],
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
