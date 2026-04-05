import * as Automerge from '@automerge/automerge'
import type { Item } from '../../state/items'
import type { VaultItem } from './client'
import type * as vaultApi from '../vault'
import { getCachedAutomergeBinary } from '../../sync/automergeBinaryCache'

export type BranchPayload = {
  encryptedAutomergeDoc: string
  versionId: string
  parentIds: string[]
}

function hasVaultKeyAccessor(
  vault: typeof vaultApi,
): vault is typeof vaultApi & { getVaultKey: () => CryptoKey } {
  return Object.prototype.hasOwnProperty.call(vault, 'getVaultKey')
    && typeof (vault as { getVaultKey?: unknown }).getVaultKey === 'function'
}

function getHeadVersionId(item?: VaultItem): string | undefined {
  return item?.branches?.[0]?.versionId
}

export async function serializeItemAsBranch(
  item: Item,
  vault: typeof vaultApi,
  currentServerItem?: VaultItem,
): Promise<{ branches: BranchPayload[] }> {
  const cachedBinary = getCachedAutomergeBinary(item.id)
  let encryptedAutomergeDoc: string
  let versionId: string

  if (cachedBinary && hasVaultKeyAccessor(vault)) {
    let doc = Automerge.load(cachedBinary)
    doc = Automerge.change(doc, draft => {
      for (const key of Object.keys(draft as Record<string, unknown>)) {
        delete (draft as Record<string, unknown>)[key]
      }
      Object.assign(draft as Record<string, unknown>, item as unknown as Record<string, unknown>)
    })

    const binary = Automerge.save(doc)
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      vault.getVaultKey(),
      binary as BufferSource,
    )

    const ivHex = Array.from(iv).map(byte => byte.toString(16).padStart(2, '0')).join('')
    const ctHex = Array.from(new Uint8Array(cipher)).map(byte => byte.toString(16).padStart(2, '0')).join('')
    encryptedAutomergeDoc = ivHex + ctHex
    versionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  } else {
    const encrypted = await vault.encryptObjectAsAutomerge(item)
    encryptedAutomergeDoc = encrypted.encryptedAutomergeDoc
    versionId = encrypted.versionId
  }

  const headVersionId = getHeadVersionId(currentServerItem)
  return {
    branches: [{
      encryptedAutomergeDoc,
      versionId,
      parentIds: headVersionId ? [headVersionId] : [],
    }],
  }
}
