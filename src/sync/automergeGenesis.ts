import * as Automerge from '@automerge/automerge'
import type { Item } from '../state/items'
import { setCachedAutomergeBinary } from './automergeBinaryCache'

export function createAutomergeGenesisBinary(item: Item): Uint8Array {
  const doc = Automerge.from(item as unknown as Record<string, unknown>)
  return Automerge.save(doc)
}

export function cacheAutomergeGenesisBinary(item: Item): Uint8Array {
  const binary = createAutomergeGenesisBinary(item)
  setCachedAutomergeBinary(item.id, binary)
  return binary
}