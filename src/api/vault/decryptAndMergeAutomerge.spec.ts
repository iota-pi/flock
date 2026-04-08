import * as Automerge from '@automerge/automerge'
import { describe, expect, it } from 'vitest'
import { decryptAndMergeAutomerge } from './decryptAndMergeAutomerge'
import { encryptObjectAsAutomergeWithKey } from './crypto'

describe('decryptAndMergeAutomerge', () => {
  it('decrypts a branch produced by encryptObjectAsAutomergeWithKey', async () => {
    const key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )

    const payload = {
      id: 'item-1',
      type: 'person',
      name: 'Alice',
      archived: false,
    }

    const encrypted = await encryptObjectAsAutomergeWithKey(key, payload)

    const merged = await decryptAndMergeAutomerge([
      {
        encryptedAutomergeDoc: encrypted.encryptedAutomergeDoc,
        versionId: encrypted.versionId,
        parentIds: [],
      },
    ], key)

    const materialized = Automerge.toJS(merged.mergedDoc) as Record<string, unknown>

    expect(materialized.id).toBe('item-1')
    expect(materialized.type).toBe('person')
    expect(materialized.name).toBe('Alice')
    expect(merged.mergedBinary.byteLength).toBeGreaterThan(0)
  })
})
