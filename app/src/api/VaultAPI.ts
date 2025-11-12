import type { AccountMetadata } from '../state/account'
import type { ItemType } from '../state/items'
import type { FlockPushSubscription } from '../utils/firebase-types'
import { getAccountId, flockRequestChunked, flockRequest } from './util'
import type { CryptoResult } from './Vault'
import env from '../env'

const ENDPOINT = env.VAULT_ENDPOINT

export interface VaultKey {
  item: string,
}

export interface VaultItem extends VaultKey {
  cipher: string,
  metadata: {
    type: ItemType,
    iv: string,
    modified: number,
  },
}

export type CachedVaultItem = Partial<VaultItem> & VaultKey

export interface VaultSubscription {
  subscription: FlockPushSubscription,
}


export async function vaultFetchMany({
  cacheTime,
  ids,
}: {
  cacheTime?: number | null,
  ids?: string[],
}): Promise<VaultItem[]> {
  if (cacheTime !== undefined && ids) {
    throw new Error('Cannot use cacheTime and ids together')
  }
  let url = `${ENDPOINT}/${getAccountId()}/items`
  if (cacheTime !== undefined) {
    if (cacheTime) {
      url = `${url}?since=${cacheTime}`
    }
    const result = await flockRequest(a => a.get(url))
    return result.data.items
  } else if (ids) {
    const result = await flockRequestChunked(
      {
        data: [ids],
        requestFactory: (
          a => batch => a.get(
            `${url}?ids=${batch.join(',')}`
          )
        ),
      },
    )
    return result.flatMap(r => r.data.items)
  } else {
    throw new Error('Must provide cacheTime or ids')
  }
}

export async function vaultFetch({ item }: VaultKey): Promise<VaultItem> {
  const url = `${ENDPOINT}/${getAccountId()}/items/${item}`
  const result = await flockRequest(a => a.get(url))
  return result.data.items[0]
}

export async function vaultPut({ cipher, item, metadata }: VaultItem) {
  const url = `${ENDPOINT}/${getAccountId()}/items/${item}`
  const result = await flockRequest(
    a => a.put(url, { cipher, ...metadata }),
  )
  const success = result.data.success || false
  if (!success) {
    throw new Error('VaultAPI put operation failed')
  }
}

export async function vaultPutMany({ items }: { items: VaultItem[] }) {
  const url = `${ENDPOINT}/${getAccountId()}/items`
  const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }))
  const result = await flockRequestChunked(
    {
      data,
      requestFactory: a => batch => a.put(url, batch),
    },
  )
  const success = result.filter(r => !r.data.success).length === 0
  if (!success) {
    throw new Error('VaultAPI putMany operation failed')
  }
}

export async function vaultDelete({ item }: VaultKey) {
  const url = `${ENDPOINT}/${getAccountId()}/items/${item}`
  const result = await flockRequest(a => a.delete(url))
  const success = result.data.success || false
  if (!success) {
    throw new Error('VaultAPI delete opteration failed')
  }
}

export async function vaultDeleteMany({ items }: & { items: string[] }) {
  const url = `${ENDPOINT}/${getAccountId()}/items`
  const result = await flockRequestChunked(
    {
      data: items,
      requestFactory: a => batch => a.delete(url, { data: batch }),
    },
  )
  const success = result.filter(r => !r.data.success).length === 0
  if (!success) {
    throw new Error('VaultAPI deleteMany opteration failed')
  }
}

type VaultCreateAccountResult = { account: string, salt: string, tempAuthToken: string }
export async function vaultCreateAccount(): Promise<VaultCreateAccountResult> {
  const url = `${ENDPOINT}/account`
  const result = await flockRequest({
    factory: a => a.post(url, {}),
    options: { allowNoInit: true },
  })
  const { account, salt, tempAuthToken } = result.data satisfies VaultCreateAccountResult
  return { account, salt, tempAuthToken }
}

export async function vaultGetSalt() {
  const url = `${ENDPOINT}/${getAccountId()}/salt`
  const result = await flockRequest({
    factory: a => a.get(url),
    options: { allowNoInit: true },
  })
  if (!result.data.success || !result.data.salt) {
    throw new Error('Could not get salt from server')
  }
  if (typeof result.data.salt !== 'string') {
    throw new Error('Invalid salt format from server')
  }
  return result.data.salt as string
}

export async function vaultGetMetadata() {
  const url = `${ENDPOINT}/${getAccountId()}`
  const result = await flockRequest(a => a.get(url))
  if (!result.data.metadata) {
    throw new Error('No metadata found for account')
  }
  // Data is encrypted, but `AccountMetadata` is for backwards compatibility
  return result.data.metadata as (AccountMetadata | CryptoResult) || {}
}

export async function vaultSetAuthToken({ tempAuthToken }: { tempAuthToken: string }) {
  const url = `${ENDPOINT}/${getAccountId()}`
  const result = await flockRequest(
    a => a.patch(url, { tempAuthToken }),
  )
  return result.data.success as boolean
}

export async function vaultSetMetadata(metadata: CryptoResult) {
  const url = `${ENDPOINT}/${getAccountId()}`
  const result = await flockRequest(a => a.patch(url, { metadata }))
  return result.data.success as boolean
}

export async function vaultSetSubscription(
  {
    subscriptionId,
    subscription,
  }: VaultSubscription & { subscriptionId: string },
) {
  const url = `${ENDPOINT}/${getAccountId()}/subscriptions/${subscriptionId}`
  const result = await flockRequest(a => a.put(url, { ...subscription }))
  return result.data.success as boolean
}

export async function vaultDeleteSubscription({ subscriptionId }: { subscriptionId: string }) {
  const url = `${ENDPOINT}/${getAccountId()}/subscriptions/${subscriptionId}`
  const result = await flockRequest(a => a.delete(url))
  return result.data.success as boolean
}

export async function vaultGetSubscription({ subscriptionId }: { subscriptionId: string }) {
  const url = `${ENDPOINT}/${getAccountId()}/subscriptions/${subscriptionId}`
  const result = await flockRequest(a => a.get(url))
  if (!result.data.success) {
    throw new Error(`Could not get subscription info from server: ${subscriptionId}`)
  }
  return result.data.subscription as FlockPushSubscription | null
}
