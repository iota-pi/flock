import type { Item } from '../state/items'
import type { AccountMetadata } from '../state/metadata'
import {
  listAutomergeItemIds,
  hydrateAutomergeDocumentBinary,
  getAutomergeMetadata,
} from '../sync/automergeDocStore'
import { fetchMany } from '../api/vault/ItemClient'
import { decryptObject, decryptBytes, type CryptoResult } from '../api/vault'
import { hasApiAuthToken } from '../api/runtime'
import { trpcClient } from '../api/trpcClient'

export class LegacyBootstrapper {
  constructor(
    private getContext: () => {
      accountId: string | null
    },
    private storeItems: (items: Item[]) => Promise<void>,
    private mutateMetadata: (changes: Partial<AccountMetadata>) => Promise<void>
  ) {}

  async bootstrapLegacyItems() {
    const { accountId } = this.getContext()
    if (!accountId) return

    const knownItemIds = await listAutomergeItemIds(accountId)
    if (knownItemIds.length > 0) return

    if (!hasApiAuthToken()) {
      throw new Error('[LegacyBootstrapper] No API auth token found, cannot bootstrap legacy items')
    }

    const response = await fetchMany({
      account: accountId,
    }).catch(e => {
      console.error('[LegacyBootstrapper] failed to fetch item snapshots', e)
      return { items: [] as any[] }
    })

    const fetchedItems = response.items.filter(
      (entry: any) =>
        entry &&
        typeof entry === 'object' &&
        typeof entry.item === 'string' &&
        entry.item.length > 0,
    )

    if (fetchedItems.length === 0) return

    const snapshots: Item[] = []

    const promises = fetchedItems.map(async (item: any) => {
      try {
        if (item.metadata?.deleted === true) {
          snapshots.push({ id: item.item, deleted: true } as unknown as Item)
          return
        }

        if (item.snapshot) {
          const binary = await this.decryptSnapshotBinary(item.snapshot)
          if (binary) {
            await hydrateAutomergeDocumentBinary(accountId, item.item, binary)
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
        console.error('[LegacyBootstrapper] failed to hydrate fetched item envelope', {
          itemId: item.item,
          error,
        })
      }
    })

    await Promise.allSettled(promises)

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
    const { accountId } = this.getContext()
    if (!accountId || !hasApiAuthToken()) return

    const localMetadata = await getAutomergeMetadata(accountId)
    if (Object.keys(localMetadata || {}).length > 0) return

    const response = await trpcClient.accounts.getMetadata.query({ account: accountId }).catch(() => null)
    if (
      response?.success &&
      !!response.metadata &&
      typeof response.metadata === 'object' &&
      !Array.isArray(response.metadata)
    ) {
      try {
        await this.mutateMetadata(response.metadata as AccountMetadata)
      } catch (error) {
        console.error('[LegacyBootstrapper] metadata hydration skipped', error)
      }
    }
  }
}
