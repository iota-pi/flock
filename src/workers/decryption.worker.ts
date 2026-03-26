/// <reference lib="webworker" />
import type { VaultItem } from '../api/VaultAPI'
import { toBytes } from '../api/pure-crypto'

type DecryptionWorkerInput = {
  key: CryptoKey
  items: VaultItem[]
}

type HydratedItem = Record<string, unknown> & { version?: number }

declare const self: DedicatedWorkerGlobalScope

self.onmessage = async (event: MessageEvent<DecryptionWorkerInput>) => {
  const { key, items } = event.data
  const decryptedItems: HydratedItem[] = []

  for (const item of items) {
    if (item.metadata?.deleted === true) {
      decryptedItems.push(item as unknown as HydratedItem)
      continue
    }

    const cipher = item.cipher
    const iv = item.metadata?.iv
    if (!cipher || !iv) {
      continue
    }

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(toBytes(iv)),
        },
        key,
        toBytes(cipher),
      )

      const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as HydratedItem
      if (typeof item.metadata?.version === 'number') {
        parsed.version = item.metadata.version
      }
      decryptedItems.push(parsed)
    } catch {
      // Skip malformed or undecryptable entries and continue.
    }
  }

  self.postMessage(decryptedItems)
}
