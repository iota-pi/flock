/// <reference lib="webworker" />
import * as Automerge from '@automerge/automerge'
import { expose } from 'comlink'
import type { VaultBranch } from '../shared/itemTypes'
import {
  decodeEncryptedAutomergeDoc,
  encodeEncryptedAutomergeDoc,
} from '../shared/automergeBranchCipher'

type ResolvedBranch = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

type ResolveConflictRequest = {
  key: CryptoKey
  itemId: string
  localBranches: ResolvedBranch[]
  serverBranches: ResolvedBranch[]
}

type RescueStaleBranchRequest = {
  key: CryptoKey
  itemId: string
  localBranch: ResolvedBranch
  serverBranch: ResolvedBranch
}

async function decryptAutomergeBinary(
  encryptedDoc: string,
  key: CryptoKey,
): Promise<Uint8Array> {
  const decoded = decodeEncryptedAutomergeDoc(encryptedDoc)

  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decoded.iv,
    },
    key,
    decoded.cipher,
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

  return encodeEncryptedAutomergeDoc({
    iv,
    cipher: ciphertext,
  })
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

const api = {
  async resolveQueueConflict(request: ResolveConflictRequest): Promise<ResolvedBranch> {
    return mergeBranchesToResolvedBranch(
      [...request.localBranches, ...request.serverBranches],
      request.key,
    )
  },
  async rescueStaleCompactedBranch(request: RescueStaleBranchRequest): Promise<ResolvedBranch> {
    return rescueStaleCompactedBranch(
      request.localBranch,
      request.serverBranch,
      request.key,
    )
  },
}

expose(api)
