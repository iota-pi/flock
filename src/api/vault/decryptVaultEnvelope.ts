import * as Automerge from '@automerge/automerge'
import type { VaultEnvelope } from '../../vault/types'
import { decryptAndMergeAutomerge } from './decryptAndMergeAutomerge'

export type DecryptedVaultEnvelope<T> = {
  materialized: T
  automergeBinary?: Uint8Array
}

export async function decryptVaultEnvelope<T extends object>(input: {
  envelope: VaultEnvelope
  key: CryptoKey
  decryptLegacyEnvelope: (payload: { cipher: string; iv: string }) => Promise<object>
}): Promise<DecryptedVaultEnvelope<T>> {
  const { envelope, key, decryptLegacyEnvelope } = input

  switch (envelope.kind) {
    case 'legacy': {
      const materialized = await decryptLegacyEnvelope({
        cipher: envelope.cipher,
        iv: envelope.iv,
      }) as T

      return { materialized }
    }
    case 'branching': {
      const merged = await decryptAndMergeAutomerge(envelope.branches, key)
      return {
        materialized: Automerge.toJS(merged.mergedDoc) as T,
        automergeBinary: merged.mergedBinary,
      }
    }
  }
}