/// <reference lib="webworker" />
import * as Automerge from '@automerge/automerge'
import type { VaultItem } from '../api/VaultAPI'
import { toBytes } from '../api/pure-crypto'

type DecryptionWorkerInput = {
  jobId?: number
  key: CryptoKey
  items: VaultItem[]
}

type HydratedItem = Record<string, unknown> & { version?: number }

declare const self: DedicatedWorkerGlobalScope

/**
 * Scenario A: Legacy Item
 * Decrypt cipher and return plain JSON
 */
async function decryptLegacyItem(
  item: VaultItem,
  key: CryptoKey,
): Promise<HydratedItem | null> {
  const cipher = item.cipher
  const iv = item.metadata?.iv
  if (!cipher || !iv) {
    return null
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
    return parsed
  } catch (e) {
    console.error('Failed to decrypt legacy item', e)
    return null
  }
}

/**
 * Decrypt an Automerge document from encrypted binary
 */
async function decryptAutomergeDoc(
  encryptedDoc: string, // Base64-encoded
  key: CryptoKey,
): Promise<Uint8Array | null> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(toBytes(encryptedDoc.slice(0, 32))), // IV is first 16 bytes (32 hex chars)
      },
      key,
      toBytes(encryptedDoc.slice(32)), // Ciphertext is remainder
    )
    return new Uint8Array(plaintext)
  } catch (e) {
    console.error('Failed to decrypt Automerge doc', e)
    return null
  }
}

/**
 * Scenario B: Upgraded Item with 1 Branch
 * Decrypt and load Automerge document
 */
async function decryptSingleBranch(
  item: VaultItem,
  key: CryptoKey,
): Promise<HydratedItem | null> {
  if (!item.branches || item.branches.length !== 1) {
    return null
  }

  const branch = item.branches[0]
  const decryptedBinary = await decryptAutomergeDoc(branch.encryptedAutomergeDoc, key)
  if (!decryptedBinary) {
    return null
  }

  try {
    const doc = Automerge.load(decryptedBinary)
    const materialized = Automerge.toJS(doc) as HydratedItem
    if (typeof item.metadata?.version === 'number') {
      materialized.version = item.metadata.version
    }
    return materialized
  } catch (e) {
    console.error('Failed to load Automerge doc', e)
    return null
  }
}

/**
 * Scenario C: Conflict! (branches.length > 1)
 * Decrypt, merge, and return merged result
 * Also triggers background resolution push
 */
async function decryptAndMergeMultipleBranches(
  item: VaultItem,
  key: CryptoKey,
): Promise<{ merged: HydratedItem; resolutionBranch: { encryptedAutomergeDoc: string; versionId: string; parentIds: string[] } } | null> {
  if (!item.branches || item.branches.length <= 1) {
    return null
  }

  const decryptedDocs: Uint8Array[] = []
  const versionIds: string[] = []

  for (const branch of item.branches) {
    const decrypted = await decryptAutomergeDoc(branch.encryptedAutomergeDoc, key)
    if (!decrypted) {
      console.error('Failed to decrypt a branch, aborting merge')
      return null
    }
    decryptedDocs.push(decrypted)
    versionIds.push(branch.versionId)
  }

  try {
    // Load all documents
    const docs = decryptedDocs.map(binary => Automerge.load(binary))

    // Merge deterministically: merge all into first
    let merged = docs[0]
    for (let i = 1; i < docs.length; i++) {
      merged = Automerge.merge(merged, docs[i])
    }

    // Materialize to JSON
    const materialized = Automerge.toJS(merged) as HydratedItem
    if (typeof item.metadata?.version === 'number') {
      materialized.version = item.metadata.version
    }

    // Save and encrypt the merged document for background resolution
    const mergedBinary = Automerge.save(merged)
    const encryptedResolution = await encryptAutomergeDoc(mergedBinary, key)

    // Generate new versionId (use timestamp + random suffix)
    const newVersionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`

    return {
      merged: materialized,
      resolutionBranch: {
        encryptedAutomergeDoc: encryptedResolution,
        versionId: newVersionId,
        parentIds: versionIds,
      },
    }
  } catch (e) {
    console.error('Failed to merge Automerge docs', e)
    return null
  }
}

/**
 * Encrypt Automerge binary document
 */
async function encryptAutomergeDoc(
  doc: Uint8Array,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    doc as BufferSource,
  )
  // Concatenate IV + ciphertext as hex string
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
  const ctHex = Array.from(new Uint8Array(ciphertext)).map(b => b.toString(16).padStart(2, '0')).join('')
  return ivHex + ctHex
}

self.onmessage = async (event: MessageEvent<DecryptionWorkerInput>) => {
  const { jobId, key, items } = event.data
  const decryptedItems: HydratedItem[] = []
  const resolutionItems: Array<{ itemId: string; branch: { encryptedAutomergeDoc: string; versionId: string; parentIds: string[] } }> = []

  for (const item of items) {
    if (item.metadata?.deleted === true) {
      decryptedItems.push(item as unknown as HydratedItem)
      continue
    }

    // Scenario A: Legacy Item
    if (item.cipher && !item.branches) {
      const decrypted = await decryptLegacyItem(item, key)
      if (decrypted) {
        decryptedItems.push(decrypted)
      }
      continue
    }

    // Scenario B: Single Branch (Upgraded Item)
    if (item.branches && item.branches.length === 1) {
      const decrypted = await decryptSingleBranch(item, key)
      if (decrypted) {
        decryptedItems.push(decrypted)
      }
      continue
    }

    // Scenario C: Multiple Branches (Conflict)
    if (item.branches && item.branches.length > 1) {
      const result = await decryptAndMergeMultipleBranches(item, key)
      if (result) {
        decryptedItems.push(result.merged)
        // Queue for background resolution
        resolutionItems.push({
          itemId: item.item,
          branch: result.resolutionBranch,
        })
      }
      continue
    }
  }

  self.postMessage({ jobId, items: decryptedItems, resolutionItems })
}
