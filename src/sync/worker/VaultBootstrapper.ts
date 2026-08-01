import type { Item } from '../../state/items'
import type { AccountMetadata } from '../../state/metadata'
import { AutomergeDocStore } from './docStore'
import { AutomergeIndexManager } from './docStore/AutomergeIndexManager'
import { fetchMany } from '../../api/vault/ItemClient'
import { decryptObject, decryptBytes, type CryptoResult } from '../../api/vault'
import { hasApiAuthToken } from '../../api/runtime'
import { VaultItem } from 'src/vault/drivers/base'
import type { ItemId } from 'src/shared/schemas/items'
import { getTrpcClient } from 'src/api/trpcClient'

export class VaultBootstrapper {
  constructor(
    private deps: {
      accountId: string
      docStore: AutomergeDocStore
      indexManager: AutomergeIndexManager
    },
    private storeItems: (items: Item[]) => Promise<void>,
    private mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  ) {}

  async bootstrapItems() {
    if (!this.deps.accountId) return
    const knownItemIds = await this.deps.indexManager.listAutomergeItemIds()
    if (knownItemIds.length > 0) return

    if (!hasApiAuthToken()) {
      throw new Error('[VaultBootstrapper] No API auth token found, cannot bootstrap initial items')
    }

    const response = await fetchMany({
      account: this.deps.accountId,
    }).catch(e => {
      console.error('[VaultBootstrapper] failed to fetch item snapshots', e)
      return { items: [] as VaultItem[] }
    })

    const fetchedItems = response.items.filter(
      entry =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.item === 'string' &&
        entry.item.length > 0,
    )

    if (fetchedItems.length === 0) return

    const snapshots: Item[] = []
    const hydratedIds: ItemId[] = []

    const promises = fetchedItems.map(async item => {
      try {
        if (item.metadata?.deleted === true) {
          snapshots.push({ id: item.item, deleted: true } as unknown as Item)
          return
        }

        if (item.snapshot) {
          const binary = await this.decryptSnapshotBinary(item.snapshot)
          if (binary) {
            await this.deps.docStore.hydrateAutomergeDocumentBinary(item.item, binary)
            hydratedIds.push(item.item as ItemId)
            return
          }
        }

        if (
          typeof item.cipher === 'string' &&
          item.cipher.length > 0 &&
          typeof item.metadata?.iv === 'string' &&
          item.metadata.iv.length > 0
        ) {
          const decrypted = await decryptObject({
            iv: item.metadata.iv,
            cipher: item.cipher,
          }).catch(() => null)

          if (decrypted && typeof decrypted === 'object' && !Array.isArray(decrypted)) {
            const snapshot = { ...(decrypted as Record<string, unknown>) }
            if (!snapshot.id || typeof snapshot.id !== 'string') {
              snapshot.id = item.item
            }
            snapshots.push(snapshot as Item)
          }
        }
      } catch (error) {
        console.error('[VaultBootstrapper] failed to hydrate fetched item envelope', {
          itemId: item.item,
          error,
        })
      }
    })

    await Promise.allSettled(promises)

    if (hydratedIds.length > 0) {
      await this.deps.indexManager.addAutomergeItemIdsToIndex(hydratedIds)
    }

    if (snapshots.length > 0) {
      await this.storeItems(snapshots)
    }

    await this.hydrateMetadata()
  }

  private async decryptSnapshotBinary(
    encryptedAutomergeDoc: CryptoResult,
  ): Promise<Uint8Array | null> {
    try {
      return decryptBytes(encryptedAutomergeDoc)
    } catch {
      return null
    }
  }

  private async hydrateMetadata() {
    if (!hasApiAuthToken()) return

    const localMetadata = await this.deps.indexManager.getAutomergeMetadata()
    if (Object.keys(localMetadata || {}).length > 0) return

    const response = await getTrpcClient().accounts.getMetadata.query({ account: this.deps.accountId }).catch(() => null)
    if (
      response?.success &&
      !!response.metadata &&
      typeof response.metadata === 'object' &&
      !Array.isArray(response.metadata)
    ) {
      try {
        await this.mutateMetadata(response.metadata as AccountMetadata)
      } catch (error) {
        console.error('[VaultBootstrapper] metadata hydration skipped', error)
      }
    }
  }
}
