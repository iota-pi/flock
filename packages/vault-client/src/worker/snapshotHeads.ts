import type { ItemId } from '@vault/shared'
import type { CryptoResult } from '../keys/crypto'
import type { KeyProvider } from '../keys/Keyring'
import { decryptWithKeyResolution, type DecryptKeyResolutionOptions } from './utils/decryptWithKeyResolution'

/**
 * Encrypts a snapshot's Automerge heads, bound to its item with their own purpose, so that they can't
 * be served as the item's snapshot or as another item's heads
 */
export async function encryptSnapshotHeads(keys: KeyProvider, itemId: ItemId, heads: string[]): Promise<CryptoResult> {
  return keys.encryptBytes(new TextEncoder().encode(JSON.stringify(heads)), itemId, 'heads')
}

/** Decrypts heads that `encryptSnapshotHeads` wrote. Throws unless they decrypt to a list of hashes. */
export async function decryptSnapshotHeads(
  keys: KeyProvider,
  itemId: ItemId,
  payload: CryptoResult,
  options?: Omit<DecryptKeyResolutionOptions, 'docId' | 'purpose'>,
): Promise<string[]> {
  const bytes = await decryptWithKeyResolution(keys, payload, { ...options, docId: itemId, purpose: 'heads' })
  const heads: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!Array.isArray(heads) || heads.length === 0 || !heads.every(head => typeof head === 'string')) {
    throw new Error(`Snapshot heads for item ${itemId} are malformed`)
  }
  return heads
}
