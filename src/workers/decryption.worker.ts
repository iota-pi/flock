/// <reference lib="webworker" />
import * as Automerge from '@automerge/automerge'
import type { VaultItem } from '../api/vault/client'
import type { ItemId, VaultBranch } from '../shared/itemTypes'
import { toBytes } from '../api/vault/crypto'

type DecryptItemsWorkerInput = {
  type?: 'DECRYPT_ITEMS'
  jobId?: number
  key: CryptoKey
  items: VaultItem[]
}

type EvaluateHistoryWorkerInput = {
  type: 'EVALUATE_HISTORY'
  jobId?: number
  key: CryptoKey
  itemId: ItemId
  history: VaultItem[]
}

type ResolveQueueConflictWorkerInput = {
  type: 'RESOLVE_QUEUE_CONFLICT'
  jobId?: number
  key: CryptoKey
  itemId: ItemId
  localBranches: VaultBranch[]
  serverBranches: VaultBranch[]
}

type CompactItemWorkerInput = {
  type: 'COMPACT_ITEM'
  jobId?: number
  key: CryptoKey
  itemId: ItemId
  baseVersionId: string
  automergeBinary: Uint8Array
}

type RescueStaleCompactedBranchWorkerInput = {
  type: 'RESCUE_STALE_COMPACTED_BRANCH'
  jobId?: number
  key: CryptoKey
  itemId: ItemId
  localBranch: VaultBranch
  serverBranch: VaultBranch
}

type MergeObjectsWorkerInput = {
  type: 'MERGE_OBJECTS'
  jobId?: number
  left: Record<string, unknown>
  right: Record<string, unknown>
}

type DecryptionWorkerInput =
  | DecryptItemsWorkerInput
  | EvaluateHistoryWorkerInput
  | ResolveQueueConflictWorkerInput
  | CompactItemWorkerInput
  | RescueStaleCompactedBranchWorkerInput
  | MergeObjectsWorkerInput

type HydratedItem = Record<string, unknown> & {
  id?: ItemId
  automergeBinary?: Uint8Array
}

type ConflictResolvedMessage = {
  type: 'CONFLICT_RESOLVED'
  jobId?: number
  itemId: ItemId
  resolvedBranch: VaultBranch
}

type DecryptionResultMessage = {
  type: 'DECRYPTION_RESULT'
  jobId?: number
  items: HydratedItem[]
}

type CorruptedItemDetectedMessage = {
  type: 'CORRUPTED_ITEM_DETECTED'
  jobId?: number
  itemId: ItemId
  failedBranches?: string[]
}

type HistoryEvaluatedMessage = {
  type: 'HISTORY_EVALUATED'
  jobId?: number
  itemId: ItemId
  healthyEnvelope: VaultItem | null
}

type QueueConflictResolvedMessage = {
  type: 'QUEUE_CONFLICT_RESOLVED'
  jobId?: number
  itemId: ItemId
  resolvedBranch: VaultBranch
}

type CompactedEnvelopeMessage = {
  type: 'COMPACTED_ENVELOPE'
  jobId?: number
  itemId: ItemId
  baseVersionId: string
  compactedBranch: VaultBranch
  compactedBinary: Uint8Array
}

type StaleCompactedBranchRescuedMessage = {
  type: 'STALE_COMPACTED_BRANCH_RESCUED'
  jobId?: number
  itemId: ItemId
  rescuedBranch: VaultBranch
}

type MergedObjectsMessage = {
  type: 'MERGED_OBJECTS'
  jobId?: number
  merged: Record<string, unknown>
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

function createVersionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function deepMergeServerAndLocal(serverValue: unknown, localValue: unknown): unknown {
  if (Array.isArray(serverValue) && Array.isArray(localValue)) {
    return localValue
  }

  if (
    serverValue
    && typeof serverValue === 'object'
    && localValue
    && typeof localValue === 'object'
    && !Array.isArray(serverValue)
    && !Array.isArray(localValue)
  ) {
    const merged: Record<string, unknown> = {
      ...(serverValue as Record<string, unknown>),
    }

    for (const [key, localChild] of Object.entries(localValue as Record<string, unknown>)) {
      merged[key] = deepMergeServerAndLocal(merged[key], localChild)
    }

    return merged
  }

  return localValue === undefined ? serverValue : localValue
}

async function mergeBranchesToResolvedBranch(
  branches: VaultBranch[],
  key: CryptoKey,
): Promise<VaultBranch> {
  if (branches.length === 0) {
    throw new Error('Cannot merge conflict with zero branches')
  }

  const docs = await Promise.all(branches.map(async branch => {
    const binary = await decryptAutomergeBinary(branch.encryptedAutomergeDoc, key)
    return Automerge.load(binary)
  }))

  let mergedDoc = docs[0]
  for (let index = 1; index < docs.length; index += 1) {
    mergedDoc = Automerge.merge(mergedDoc, docs[index])
  }

  const mergedBinary = Automerge.save(mergedDoc)
  const encryptedAutomergeDoc = await encryptAutomergeBinary(mergedBinary, key)

  return {
    encryptedAutomergeDoc,
    versionId: createVersionId(),
    parentIds: branches.map(branch => branch.versionId),
  }
}

async function compactItemBranchFromBinary(
  automergeBinary: Uint8Array,
  key: CryptoKey,
): Promise<{ compactedBinary: Uint8Array; compactedBranch: VaultBranch }> {
  const sourceDoc = Automerge.load(automergeBinary)
  const materializedState = JSON.parse(JSON.stringify(Automerge.toJS(sourceDoc))) as Record<string, unknown>
  const compactedDoc = Automerge.from(materializedState)
  const compactedBinary = Automerge.save(compactedDoc)
  const encryptedAutomergeDoc = await encryptAutomergeBinary(compactedBinary, key)

  return {
    compactedBinary,
    compactedBranch: {
      encryptedAutomergeDoc,
      versionId: createVersionId(),
      parentIds: [],
    },
  }
}

async function rescueStaleCompactedBranch(
  localBranch: VaultBranch,
  serverBranch: VaultBranch,
  key: CryptoKey,
): Promise<VaultBranch> {
  const localBinary = await decryptAutomergeBinary(localBranch.encryptedAutomergeDoc, key)
  const serverBinary = await decryptAutomergeBinary(serverBranch.encryptedAutomergeDoc, key)

  const localState = JSON.parse(JSON.stringify(Automerge.toJS(Automerge.load(localBinary)))) as Record<string, unknown>
  const serverState = JSON.parse(JSON.stringify(Automerge.toJS(Automerge.load(serverBinary)))) as Record<string, unknown>
  const mergedState = deepMergeServerAndLocal(serverState, localState) as Record<string, unknown>

  const rescuedDoc = Automerge.from(mergedState)
  const rescuedBinary = Automerge.save(rescuedDoc)
  const encryptedAutomergeDoc = await encryptAutomergeBinary(rescuedBinary, key)

  return {
    encryptedAutomergeDoc,
    versionId: createVersionId(),
    parentIds: [serverBranch.versionId],
  }
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .map(item => stripUndefinedDeep(item))
      .filter(item => item !== undefined)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (
    value instanceof Date
    || value instanceof Uint8Array
    || value instanceof ArrayBuffer
  ) {
    return value
  }

  const input = value as Record<string, unknown>
  const cleaned: Record<string, unknown> = {}
  for (const [key, nested] of Object.entries(input)) {
    if (nested === undefined) {
      continue
    }
    cleaned[key] = stripUndefinedDeep(nested)
  }

  return cleaned
}

function mergePlainObjectsWithAutomerge(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): Record<string, unknown> {
  const leftDoc = Automerge.from(stripUndefinedDeep(left) as Record<string, unknown>)
  const rightDoc = Automerge.from(stripUndefinedDeep(right) as Record<string, unknown>)
  const merged = Automerge.merge(leftDoc, rightDoc)
  return Automerge.toJS(merged) as Record<string, unknown>
}

export async function processIncomingItem(
  envelope: VaultItem,
  key: CryptoKey,
): Promise<{
  item: HydratedItem | null
  resolvedBranch?: VaultBranch
  corrupted?: {
    itemId: ItemId
    failedBranches?: string[]
  }
}> {
  try {
    const branches = Array.isArray(envelope.branches) ? envelope.branches : []
    const hasBranches = branches.length > 0

    // Scenario 1: Branching format (single or multiple branches)
    if (hasBranches) {
      // Phase 1: Decrypt and validate each branch independently
      const decryptedBranches: Array<{
        versionId: string
        doc: Automerge.Doc<unknown>
        binary: Uint8Array
        valid: true
      } | {
        versionId: string
        valid: false
      }> = []

      for (const branch of branches) {
        try {
          const binary = await decryptAutomergeBinary(branch.encryptedAutomergeDoc, key)
          const doc = Automerge.load(binary)
          decryptedBranches.push({
            versionId: branch.versionId,
            doc,
            binary,
            valid: true,
          })
        } catch (decryptError) {
          console.warn(`Failed to load branch ${branch.versionId}: ${decryptError instanceof Error ? decryptError.message : 'Unknown error'}`)
          decryptedBranches.push({
            versionId: branch.versionId,
            valid: false,
          })
        }
      }

      // Phase 2: Extract only valid branches
      const validBranches = decryptedBranches.filter(
        (branch): branch is Extract<typeof branch, { valid: true }> => branch.valid === true,
      )

      // If no valid branches, mark item as corrupted for recovery
      if (validBranches.length === 0) {
        return {
          item: null,
          corrupted: {
            itemId: envelope.item,
              failedBranches: branches.map(branch => branch.versionId),
          },
        }
      }

      // Phase 3: Merge all valid branches
      let mergedDoc = validBranches[0].doc
      let mergedBinary = validBranches[0].binary
      for (let index = 1; index < validBranches.length; index += 1) {
        mergedDoc = Automerge.merge(mergedDoc, validBranches[index].doc)
        mergedBinary = Automerge.save(mergedDoc)
      }

      // Phase 4: Encrypt and create resolution for multi-branch conflicts.
      const shouldEmitResolution = branches.length > 1
      const encryptedAutomergeDoc = shouldEmitResolution
        ? await encryptAutomergeBinary(mergedBinary, key)
        : ''

      // Include versionIds of all branches (valid and invalid) for lineage tracking
      const resolvedBranch: VaultBranch | undefined = shouldEmitResolution
        ? {
          encryptedAutomergeDoc,
          versionId: createVersionId(),
          parentIds: branches.map(branch => branch.versionId),
        }
        : undefined

      const item = materializeDoc(mergedDoc)
      item.id = envelope.item
      item.automergeBinary = mergedBinary

      // Flag if any branches were corrupted (for client UI warning)
      if (decryptedBranches.some(b => !b.valid)) {
        (item as HydratedItem & { _corruptedBranches?: string[] })._corruptedBranches = decryptedBranches
          .filter(b => !b.valid)
          .map(b => b.versionId)
      }

      return { item, resolvedBranch }
    }

    // Scenario 2: Legacy item (including rows with empty branches arrays)
    if (typeof envelope.cipher === 'string') {
      const plainJson = await decryptLegacyCipher(envelope.cipher, envelope.metadata.iv, key)
      const parsed = JSON.parse(plainJson) as HydratedItem
      parsed.id = envelope.item
      return { item: parsed }
    }

    return { item: null }
  } catch (error) {
    console.error(`[Worker] Corrupted binary for item ${envelope.item}:`, error)
    return {
      item: null,
      corrupted: {
        itemId: envelope.item,
        failedBranches: envelope.branches?.map(branch => branch.versionId),
      },
    }
  }
}

export async function evaluateHistory(
  historicalEnvelopes: VaultItem[],
  key: CryptoKey,
): Promise<VaultItem | null> {
  for (const envelope of historicalEnvelopes) {
    const testItem = await processIncomingItem(envelope, key)
    if (!testItem.corrupted && testItem.item) {
      return envelope
    }
  }
  return null
}

self.onmessage = async (event: MessageEvent<DecryptionWorkerInput>) => {
  if (event.data.type === 'MERGE_OBJECTS') {
    const { jobId, left, right } = event.data
    const merged = mergePlainObjectsWithAutomerge(left, right)
    const mergedMessage: MergedObjectsMessage = {
      type: 'MERGED_OBJECTS',
      jobId,
      merged,
    }
    self.postMessage(mergedMessage)
    return
  }

  if (event.data.type === 'COMPACT_ITEM') {
    const { jobId, key, itemId, baseVersionId, automergeBinary } = event.data
    const { compactedBinary, compactedBranch } = await compactItemBranchFromBinary(automergeBinary, key)

    const compactedMessage: CompactedEnvelopeMessage = {
      type: 'COMPACTED_ENVELOPE',
      jobId,
      itemId,
      baseVersionId,
      compactedBranch,
      compactedBinary,
    }

    self.postMessage(compactedMessage, [compactedBinary.buffer])
    return
  }

  if (event.data.type === 'RESCUE_STALE_COMPACTED_BRANCH') {
    const { jobId, key, itemId, localBranch, serverBranch } = event.data
    const rescuedBranch = await rescueStaleCompactedBranch(localBranch, serverBranch, key)

    const rescuedMessage: StaleCompactedBranchRescuedMessage = {
      type: 'STALE_COMPACTED_BRANCH_RESCUED',
      jobId,
      itemId,
      rescuedBranch,
    }

    self.postMessage(rescuedMessage)
    return
  }

  if (event.data.type === 'RESOLVE_QUEUE_CONFLICT') {
    const { jobId, key, itemId, localBranches, serverBranches } = event.data
    const resolvedBranch = await mergeBranchesToResolvedBranch(
      [...localBranches, ...serverBranches],
      key,
    )

    const message: QueueConflictResolvedMessage = {
      type: 'QUEUE_CONFLICT_RESOLVED',
      jobId,
      itemId,
      resolvedBranch,
    }
    self.postMessage(message)
    return
  }

  if (event.data.type === 'EVALUATE_HISTORY') {
    const { jobId, key, itemId, history } = event.data
    const healthyEnvelope = await evaluateHistory(history, key)

    const historyMessage: HistoryEvaluatedMessage = {
      type: 'HISTORY_EVALUATED',
      jobId,
      itemId,
      healthyEnvelope,
    }
    self.postMessage(historyMessage)
    return
  }

  const { jobId, key, items } = event.data
  const decryptedItems: HydratedItem[] = []

  for (const envelope of items) {
    if (envelope.metadata?.deleted === true) {
      decryptedItems.push({
        id: envelope.item,
      })
      continue
    }

    const result = await processIncomingItem(envelope, key)
    if (result.corrupted) {
      const corruptedMessage: CorruptedItemDetectedMessage = {
        type: 'CORRUPTED_ITEM_DETECTED',
        jobId,
        itemId: result.corrupted.itemId,
        failedBranches: result.corrupted.failedBranches,
      }
      self.postMessage(corruptedMessage)
      continue
    }

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

  const transferables: ArrayBuffer[] = []
  for (const item of decryptedItems) {
    if (item.automergeBinary instanceof Uint8Array) {
      const buffer = item.automergeBinary.buffer
      if (buffer instanceof ArrayBuffer) {
        transferables.push(buffer)
      }
    }
  }

  self.postMessage(resultMessage, transferables)
}
