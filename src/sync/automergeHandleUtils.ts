import type { DocHandle } from '@automerge/automerge-repo/slim'
import { isPlainObject } from './utils/objectUtils'


function readHandleDocSafely<TDoc extends object>(handle: DocHandle<TDoc>): TDoc | undefined {
  if (!handle) {
    return undefined
  }

  try {
    return handle.doc()
  } catch {
    return undefined
  }
}

export function readReadyObjectSnapshot<TDoc extends object>(
  handle: DocHandle<TDoc> | undefined | null,
): TDoc | null {
  if (!handle || !handle.isReady()) {
    return null
  }

  const doc = readHandleDocSafely(handle)
  return isPlainObject(doc) ? (doc as TDoc) : null
}
