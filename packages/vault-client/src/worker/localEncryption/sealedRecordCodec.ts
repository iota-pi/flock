import type { RecordCodec } from '../VaultIndexedDBStorageAdapter'
import type { LocalCipher } from './LocalCipher'

/**
 * Seals Automerge chunks with the device storage key, bound to their storage key. `getCipher` is
 * read on each use, so the adapter can be opened before the key has been loaded from its `meta` store.
 */
export function createSealedRecordCodec(getCipher: () => LocalCipher): RecordCodec {
  return {
    encode: async (key, bytes) => ({ key, ...await getCipher().seal({ store: 'automerge', key }, bytes) }),
    // Throws LocalDecryptionError for a record that doesn't verify; it's never treated as missing
    decode: async (key, record) => getCipher().open({ store: 'automerge', key }, record),
  }
}
