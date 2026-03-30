/// <reference lib="webworker" />
import * as Automerge from '@automerge/automerge'
import type { VaultItem } from '../api/VaultAPI'
import type { VaultBranch } from '../shared/itemTypes'
import { toBytes } from '../api/pure-crypto'

type DecryptionWorkerInput = {
  jobId?: number
  key: CryptoKey
  items: VaultItem[]
}

type HydratedItem = Record<string, unknown> & { id?: string; version?: number }

type ConflictResolvedMessage = {
  type: 'CONFLICT_RESOLVED'
  jobId?: number
  itemId: string
  resolvedBranch: VaultBranch
}

type DecryptionResultMessage = {
  type: 'DECRYPTION_RESULT'
  jobId?: number
  items: HydratedItem[]
}

declare const self: DedicatedWorkerGlobalScope

async function decryptLegacyCipher(
  cipher: string,
  iv: string,
  key: CryptoKey,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(toBytes(iv)),
    },
    key,
    toBytes(cipher),
  )

  return new TextDecoder().decode(plaintext)
}

async function decryptAutomergeBinary(
  encryptedDoc: string,
  key: CryptoKey,
): Promise<Uint8Array> {
  const iv = new Uint8Array(toBytes(encryptedDoc.slice(0, 32)))
  const ciphertext = toBytes(encryptedDoc.slice(32))

  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    ciphertext,
  )

  return new Uint8Array(plaintext)
}

async function encryptAutomergeBinary(
  binary: Uint8Array,
  key: CryptoKey,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
    },
    key,
    binary as BufferSource,
  )

  const ivHex = Array.from(iv).map(byte => byte.toString(16).padStart(2, '0')).join('')
  const ctHex = Array.from(new Uint8Array(ciphertext)).map(byte => byte.toString(16).padStart(2, '0')).join('')
  return ivHex + ctHex
}

function materializeDoc(doc: Automerge.Doc<unknown>): HydratedItem {
  return Automerge.toJS(doc) as HydratedItem
}

export async function processIncomingItem(
  envelope: VaultItem,
  key: CryptoKey,
): Promise<{ item: HydratedItem | null; resolvedBranch?: VaultBranch }> {
  // Scenario 1: Legacy item
  if (envelope.cipher && !envelope.branches) {
    try {
      const plainJson = await decryptLegacyCipher(envelope.cipher, envelope.metadata.iv, key)
      const parsed = JSON.parse(plainJson) as HydratedItem
      parsed.id = envelope.item
      if (typeof envelope.metadata.version === 'number') {
        parsed.version = envelope.metadata.version
      }
      return { item: parsed }
    } catch (error) {
      console.error('Failed to decrypt legacy item', error)
      return { item: null }
    }
  }

  // Scenario 2: Upgraded item with one branch
  if (envelope.branches && envelope.branches.length === 1) {
    try {
      const branch = envelope.branches[0]
      const binary = await decryptAutomergeBinary(branch.encryptedAutomergeDoc, key)
      const doc = Automerge.load(binary)
      const item = materializeDoc(doc)
      item.id = envelope.item
      if (typeof envelope.metadata.version === 'number') {
        item.version = envelope.metadata.version
      }
      return { item }
    } catch (error) {
      console.error('Failed to decrypt single Automerge branch', error)
      return { item: null }
    }
  }

  // Scenario 3: Conflict with multiple branches
  if (envelope.branches && envelope.branches.length > 1) {
    try {
      // Phase 1: Decrypt and validate each branch independently
      const decryptedBranches: Array<{
        versionId: string
        doc: Automerge.Doc<unknown>
        valid: true
      } | {
        versionId: string
        valid: false
        error: string
      }> = []

      for (const branch of envelope.branches) {
        try {
          const binary = await decryptAutomergeBinary(branch.encryptedAutomergeDoc, key)
          const doc = Automerge.load(binary)
          decryptedBranches.push({
            versionId: branch.versionId,
            doc,
            valid: true,
          })
        } catch (decryptError) {
          console.warn(`Failed to load branch ${branch.versionId}: ${decryptError instanceof Error ? decryptError.message : 'Unknown error'}`)
          decryptedBranches.push({
            versionId: branch.versionId,
            valid: false,
            error: decryptError instanceof Error ? decryptError.message : 'Decryption failed',
          })
        }
      }

      // Phase 2: Extract only valid branches
      const validBranches = decryptedBranches.filter(
        (branch): branch is Extract<typeof branch, { valid: true }> => branch.valid === true,
      )

      // If no valid branches, return null (item is unrecoverable)
      if (validBranches.length === 0) {
        console.error(`All ${envelope.branches.length} branches failed to load for item ${envelope.item}`)
        return { item: null }
      }

      // Phase 3: Merge all valid branches
      let mergedDoc = validBranches[0].doc
      for (let index = 1; index < validBranches.length; index += 1) {
        mergedDoc = Automerge.merge(mergedDoc, validBranches[index].doc)
      }

      // Phase 4: Encrypt and create resolution
      const mergedBinary = Automerge.save(mergedDoc)
      const encryptedAutomergeDoc = await encryptAutomergeBinary(mergedBinary, key)

      // Include versionIds of all branches (valid and invalid) for lineage tracking
      const resolvedBranch: VaultBranch = {
        encryptedAutomergeDoc,
        versionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        parentIds: envelope.branches.map(branch => branch.versionId),
      }

      const item = materializeDoc(mergedDoc)
      item.id = envelope.item

      // Flag if any branches were corrupted (for client UI warning)
      if (decryptedBranches.some(b => !b.valid)) {
        (item as HydratedItem & { _corruptedBranches?: string[] })._corruptedBranches = decryptedBranches
          .filter(b => !b.valid)
          .map(b => b.versionId)
      }

      if (typeof envelope.metadata.version === 'number') {
        item.version = envelope.metadata.version
      }

      return { item, resolvedBranch }
    } catch (error) {
      console.error('Failed to merge conflicted Automerge branches', error)
      return { item: null }
    }
  }

  return { item: null }
}

self.onmessage = async (event: MessageEvent<DecryptionWorkerInput>) => {
  const { jobId, key, items } = event.data
  const decryptedItems: HydratedItem[] = []

  for (const envelope of items) {
    if (envelope.metadata?.deleted === true) {
      decryptedItems.push({
        id: envelope.item,
        version: envelope.metadata?.version,
      })
      continue
    }

    const result = await processIncomingItem(envelope, key)
    if (!result.item) {
      continue
    }

    decryptedItems.push(result.item)

    if (result.resolvedBranch) {
      const conflictMessage: ConflictResolvedMessage = {
        type: 'CONFLICT_RESOLVED',
        jobId,
        itemId: envelope.item,
        resolvedBranch: result.resolvedBranch,
      }
      self.postMessage(conflictMessage)
    }
  }

  const resultMessage: DecryptionResultMessage = {
    type: 'DECRYPTION_RESULT',
    jobId,
    items: decryptedItems,
  }
  self.postMessage(resultMessage)
}
