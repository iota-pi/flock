import type { AccountMetadata } from '../state/account'
import type { ItemType } from '../state/items'
import type { FlockPushSubscription } from '../utils/firebase-types'
import { getAccountId, getAxios, wrapManyRequests, wrapRequest } from './common'
import type { CryptoResult } from './Vault'
import env from '../env'
import type { JSONData } from '../utils/types'

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

export interface VaultAccount {
  account: string,
  metadata: Record<string, JSONData> | CryptoResult,
}

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
    url = `${url}?since=${cacheTime}`
    const result = await wrapRequest(getAxios().get(url))
    return result.data.items
  } else if (ids) {
    const result = await wrapManyRequests(
      [ids],
      batch => getAxios().get(
        `${url}?ids=${batch.join(',')}`
      ),
    )
    return result.flatMap(r => r.data.items)
  } else {
    throw new Error('Must provide cacheTime or ids')
  }
}

export async function vaultFetch({ item }: VaultKey): Promise<VaultItem> {
  const url = `${ENDPOINT}/${getAccountId()}/items/${item}`
  const result = await wrapRequest(getAxios().get(url))
  return result.data.items[0]
}

export async function vaultPut({ cipher, item, metadata }: VaultItem) {
  const url = `${ENDPOINT}/${getAccountId()}/items/${item}`
  const result = await wrapRequest(
    getAxios().put(url, { cipher, ...metadata }),
  )
  const success = result.data.success || false
  if (!success) {
    throw new Error('VaultAPI put operation failed')
  }
}

export async function vaultPutMany({ items }: { items: VaultItem[] }) {
  const url = `${ENDPOINT}/${getAccountId()}/items`
  const data = items.map(({ cipher, item, metadata }) => ({ cipher, id: item, ...metadata }))
  const result = await wrapManyRequests(
    data,
    batch => getAxios().put(url, batch),
  )
  const success = result.filter(r => !r.data.success).length === 0
  if (!success) {
    throw new Error('VaultAPI putMany operation failed')
  }
}

export async function vaultDelete({ item }: VaultKey) {
  const url = `${ENDPOINT}/${getAccountId()}/items/${item}`
  const result = await wrapRequest(getAxios().delete(url))
  const success = result.data.success || false
  if (!success) {
    throw new Error('VaultAPI delete opteration failed')
  }
}

export async function vaultDeleteMany({ items }: & { items: string[] }) {
  const url = `${ENDPOINT}/${getAccountId()}/items`
  const result = await wrapManyRequests(
    items,
    batch => getAxios().delete(url, { data: batch }),
  )
  const success = result.filter(r => !r.data.success).length === 0
  if (!success) {
    throw new Error('VaultAPI deleteMany opteration failed')
  }
}

export async function vaultCreateAccount(): Promise<boolean> {
  const url = `${ENDPOINT}/${getAccountId()}`
  const result = await wrapRequest(getAxios().post(url, {})).catch(() => ({
    data: { success: false },
  }))
  return result.data.success as boolean
}

export async function vaultCheckPassword() {
  const data = await getAccountData().catch(() => ({
    success: false,
  }))
  return data.success as boolean || false
}

export async function vaultGetMetadata() {
  const data = await getAccountData()
  return data.metadata as (AccountMetadata | CryptoResult) || {}
}

async function getAccountData() {
  const url = `${ENDPOINT}/${getAccountId()}`
  const result = await wrapRequest(getAxios().get(url))
  return result.data
}

export async function vaultSetMetadata({ metadata }: Pick<VaultAccount, 'metadata'>) {
  const url = `${ENDPOINT}/${getAccountId()}`
  const result = await wrapRequest(getAxios().patch(url, { metadata }))
  return result.data.success as boolean
}

export async function vaultSetSubscription(
  {
    subscriptionId,
    subscription,
  }: VaultSubscription & { subscriptionId: string },
) {
  const url = `${ENDPOINT}/${getAccountId()}/subscriptions/${subscriptionId}`
  const result = await wrapRequest(getAxios().put(url, { ...subscription }))
  return result.data.success as boolean
}

export async function vaultDeleteSubscription({ subscriptionId }: { subscriptionId: string }) {
  const url = `${ENDPOINT}/${getAccountId()}/subscriptions/${subscriptionId}`
  const result = await wrapRequest(getAxios().delete(url))
  return result.data.success as boolean
}

export async function vaultGetSubscription({ subscriptionId }: { subscriptionId: string }) {
  const url = `${ENDPOINT}/${getAccountId()}/subscriptions/${subscriptionId}`
  const result = await wrapRequest(getAxios().get(url))
  if (!result.data.success) {
    throw new Error(`Could not get subscription info from server: ${subscriptionId}`)
  }
  return result.data.subscription as FlockPushSubscription | null
}
