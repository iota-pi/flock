import type { AccountMetadata } from '../state/metadata'
import * as Automerge from '@automerge/automerge'
import { hasApiAuthToken } from './runtime'
import { trpcClient } from './trpcClient'
import { fetchMany } from './vault/client'
import { decryptObject, getVaultKey } from './vault'
import type { CachedVaultItem, VaultItem } from './vault/clientTypes'
import {
  addAutomergeItemIdsToIndex,
  getAutomergeMetadata,
  hydrateAutomergeDocumentBinary,
  initializeAutomergeDocStore,
  listAutomergeItemIds,
  upsertAutomergeMetadataSnapshot,
} from '../sync/automergeDocStore'
import { decodeEncryptedAutomergeDoc } from '../shared/automergeBranchCipher'

type FetchItemsOptions = {
  forceFullSync?: boolean
  forceMetadataRefetch?: boolean
}

type EnsureItemsBootstrapOptions = FetchItemsOptions & {
  force?: boolean
}

const bootstrappedAccounts = new Set<string>()
const inFlightBootstrapByAccount = new Map<string, Promise<void>>()

function isMetadataLike(value: unknown): value is AccountMetadata {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasMetadataSnapshot(metadata: AccountMetadata): boolean {
  return Object.keys(metadata || {}).length > 0
}

function normalizeItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }

  const deduped = new Set<string>()
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const candidate = entry as { item?: unknown }
    if (typeof candidate.item !== 'string' || candidate.item.length === 0) {
      continue
    }

    deduped.add(candidate.item)
  }

  return Array.from(deduped)
}

type FetchedVaultEnvelope = CachedVaultItem | VaultItem

function normalizeFetchedVaultEnvelopes(value: unknown): FetchedVaultEnvelope[] {
  if (!Array.isArray(value)) {
    return []
  }

  const envelopes: FetchedVaultEnvelope[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const itemId = (entry as { item?: unknown }).item
    if (typeof itemId !== 'string' || itemId.length === 0) {
      continue
    }

    envelopes.push(entry as FetchedVaultEnvelope)
  }

  return envelopes
}

async function decryptAutomergeBranchBinary(encryptedAutomergeDoc: string): Promise<Uint8Array> {
  const decoded = decodeEncryptedAutomergeDoc(encryptedAutomergeDoc)

  const iv = new Uint8Array(decoded.iv.byteLength)
  iv.set(decoded.iv)

  const cipher = new Uint8Array(decoded.cipher.byteLength)
  cipher.set(decoded.cipher)

  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    getVaultKey(),
    cipher,
  )

  return new Uint8Array(plaintext)
}

async function hydrateFetchedItemEnvelope(item: FetchedVaultEnvelope): Promise<void> {
  let binary: Uint8Array | null = null

  if (item.metadata?.deleted === true) {
    const snapshot = { id: item.item, deleted: true }
    binary = Automerge.save(Automerge.from(snapshot))
  } else {
    if (Array.isArray(item.branches) && item.branches.length > 0) {
      for (const branch of item.branches) {
        if (!branch || typeof branch.encryptedAutomergeDoc !== 'string' || branch.encryptedAutomergeDoc.length === 0) {
          continue
        }

        try {
          binary = await decryptAutomergeBranchBinary(branch.encryptedAutomergeDoc)
          break
        } catch {
          // Continue trying remaining branches.
        }
      }
    }

    if (!binary && typeof item.cipher === 'string' && item.cipher.length > 0 && typeof item.metadata?.iv === 'string' && item.metadata.iv.length > 0) {
      const decrypted = await decryptObject({ iv: item.metadata.iv, cipher: item.cipher }).catch(() => null)
      if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
        const snapshot = { ...(decrypted as Record<string, unknown>) }
        if (typeof snapshot.id !== 'string' || snapshot.id.length === 0) {
          snapshot.id = item.item
        }
        binary = Automerge.save(Automerge.from(snapshot))
      }
    }
  }

  if (binary) {
    await hydrateAutomergeDocumentBinary(item.item, binary)
  }
}

async function hydrateFetchedItemsLocally(items: FetchedVaultEnvelope[]): Promise<void> {
  await Promise.allSettled(items.map(async item => {
    try {
      await hydrateFetchedItemEnvelope(item)
    } catch (error) {
      console.error('[itemReadService] failed to hydrate fetched item envelope', {
        itemId: item.item,
        error,
      })
    }
  }))
}

async function hydrateMetadataIfNeeded(accountId: string, force = false): Promise<void> {
  const localMetadata = getAutomergeMetadata()
  if (!force && hasMetadataSnapshot(localMetadata)) {
    return
  }

  if (!hasApiAuthToken()) {
    return
  }

  const response = await trpcClient.accounts.getMetadata.query({ account: accountId }).catch(() => null)
  if (!response?.success || !isMetadataLike(response.metadata)) {
    return
  }

  try {
    await upsertAutomergeMetadataSnapshot(response.metadata, {
      markLocalChange: false,
    })
  } catch (error) {
    console.error('[itemReadService] metadata hydration skipped due to automerge readiness issue', error)
  }
}

export async function ensureItemsBootstrap(
  accountId: string,
  options: EnsureItemsBootstrapOptions = {},
): Promise<void> {
  const shouldForce = !!(options.force || options.forceFullSync || options.forceMetadataRefetch)

  if (!shouldForce) {
    const inFlight = inFlightBootstrapByAccount.get(accountId)
    if (inFlight) {
      return inFlight
    }
  }

  const bootstrap = (async () => {
    await initializeAutomergeDocStore(accountId)

    const knownItemIds = listAutomergeItemIds()
    if (!shouldForce && bootstrappedAccounts.has(accountId) && knownItemIds.length > 0) {
      return
    }

    if (hasApiAuthToken()) {
      const response = await fetchMany({ cacheTime: null }).catch(() => ({ items: [] as Array<{ item: string }> }))
      const fetchedItems = normalizeFetchedVaultEnvelopes(response.items)
      const fetchedItemIds = normalizeItemIds(fetchedItems)

      if (fetchedItems.length > 0) {
        await hydrateFetchedItemsLocally(fetchedItems)
      }

      if (fetchedItemIds.length > 0) {
        await addAutomergeItemIdsToIndex(fetchedItemIds)
      }
    }

    await hydrateMetadataIfNeeded(accountId, options.forceMetadataRefetch === true)

    bootstrappedAccounts.add(accountId)
  })()

  if (!shouldForce) {
    inFlightBootstrapByAccount.set(accountId, bootstrap)
  }

  await bootstrap.finally(() => {
    if (!shouldForce) {
      inFlightBootstrapByAccount.delete(accountId)
    }
  })
}
