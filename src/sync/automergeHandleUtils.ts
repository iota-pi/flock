import type { DocHandle } from '@automerge/automerge-repo/slim'
import { isPlainObject } from './utils/objectUtils'


export function readObjectSnapshot<TDoc extends object>(
  handle: DocHandle<TDoc>,
): TDoc | null {
  try {
    const doc = handle.doc()
    return isPlainObject(doc) ? (doc as TDoc) : null
  } catch {
    return null
  }
}
