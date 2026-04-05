import * as Automerge from '@automerge/automerge'
import type { ItemId } from '../shared/itemTypes'
import type { AccountMetadata } from '../state/metadata'
import { type GroupItem, type Item } from '../state/items'
import { getAccountId } from './util'
import * as vaultApi from './vault'
import { type BranchPayload, serializeItemAsBranch } from './vault/serializeItemAsBranch'
import {
  getCachedMetadataAutomergeBinary,
  setCachedMetadataAutomergeBinary,
} from '../sync/automergeBinaryCache'

export type QueuePutPayload = {
  account: string
  item: ItemId
  branches: BranchPayload[]
  modified: number
  type: Item['type']
  deleted?: boolean
}

export type QueuePutManyPayload = {
  account: string
  items: Array<{
    id: ItemId
    branches: BranchPayload[]
    modified: number
    type: Item['type']
    deleted?: boolean
  }>
}

export type QueuedItemMutationPayload =
  | {
    mutationType: 'items.put'
    payload: QueuePutPayload
  }
  | {
    mutationType: 'items.putMany'
    payload: QueuePutManyPayload
  }

export type MetadataEnvelope = {
  branches?: BranchPayload[]
}

export function dedupeItemsById(items: Item | Item[]): Item[] {
  const incoming = Array.isArray(items) ? items : [items]
  const deduped = new Map<ItemId, Item>()

  for (const item of incoming) {
    deduped.set(item.id, item)
  }

  return Array.from(deduped.values())
}

export async function buildQueuedItemMutationPayload(items: Item[]): Promise<QueuedItemMutationPayload> {
  const modified = Date.now()
  const account = getAccountId()
  const payloadItems = await Promise.all(items.map(async item => {
    const payload = await serializeItemAsBranch(item, vaultApi)

    return {
      id: item.id,
      branches: payload.branches,
      modified,
      type: item.type,
      deleted: item.deleted,
    }
  }))

  if (payloadItems.length === 1) {
    const payload = payloadItems[0]
    return {
      mutationType: 'items.put',
      payload: {
        account,
        item: payload.id,
        branches: payload.branches,
        modified: payload.modified,
        type: payload.type,
        deleted: payload.deleted,
      },
    }
  }

  return {
    mutationType: 'items.putMany',
    payload: {
      account,
      items: payloadItems,
    },
  }
}

function removeMembersFromGroup(group: GroupItem, idsSet: Set<ItemId>): GroupItem {
  return {
    ...group,
    members: group.members.filter(memberId => !idsSet.has(memberId)),
  }
}

export function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<ItemId>): GroupItem[] {
  return allItems
    .filter((item): item is GroupItem => (
      item.type === 'group' && item.members.some(memberId => idsSet.has(memberId))
    ))
    .map(group => removeMembersFromGroup(group, idsSet))
}

export async function serializeMetadataAsBranch(
  metadata: AccountMetadata,
): Promise<{ branches: BranchPayload[] }> {
  const cachedBinary = getCachedMetadataAutomergeBinary()
  let binary: Uint8Array

  if (cachedBinary) {
    let doc = Automerge.load(cachedBinary)
    doc = Automerge.change(doc, draft => {
      for (const key of Object.keys(draft as Record<string, unknown>)) {
        delete (draft as Record<string, unknown>)[key]
      }
      Object.assign(draft as Record<string, unknown>, metadata as unknown as Record<string, unknown>)
    })
    binary = Automerge.save(doc)
  } else {
    const doc = Automerge.from(metadata as unknown as Record<string, unknown>)
    binary = Automerge.save(doc)
  }

  setCachedMetadataAutomergeBinary(binary)

  let encryptedAutomergeDoc: string
  if (Object.prototype.hasOwnProperty.call(vaultApi, 'getVaultKey')
    && typeof (vaultApi as { getVaultKey?: unknown }).getVaultKey === 'function') {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      (vaultApi as typeof vaultApi & { getVaultKey: () => CryptoKey }).getVaultKey(),
      binary as BufferSource,
    )

    const ivHex = Array.from(iv).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const ctHex = Array.from(new Uint8Array(cipher)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    encryptedAutomergeDoc = ivHex + ctHex
  } else {
    const encrypted = await vaultApi.encryptObjectAsAutomerge(metadata as unknown as Record<string, unknown>)
    encryptedAutomergeDoc = encrypted.encryptedAutomergeDoc
  }

  return {
    branches: [{
      encryptedAutomergeDoc,
      versionId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      parentIds: [],
    }],
  }
}