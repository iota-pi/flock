import { decryptBytesWithKey, encryptBytesWithKey } from '../api/vault/crypto'
import { getVaultKey } from '../api/vault'

type EncryptedMessage = {
  iv: string
  cipher: string
}

export async function encryptSyncMessage(message: Uint8Array): Promise<EncryptedMessage> {
  return encryptBytesWithKey(getVaultKey(), message)
}

export async function decryptSyncMessage(message: EncryptedMessage): Promise<Uint8Array> {
  return decryptBytesWithKey(getVaultKey(), message)
}