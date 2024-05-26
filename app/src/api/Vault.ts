import {
  CachedVaultItem,
  VaultItem,
  vaultDelete,
  vaultDeleteMany,
  vaultDeleteSubscription,
  vaultFetchMany,
  vaultGetMetadata,
  vaultGetSubscription,
  vaultPut,
  vaultPutMany,
  vaultSetMetadata,
  vaultSetSubscription,
} from './VaultAPI'
import crypto from './_crypto'
import { TextEncoder as Encoder, TextDecoder as Decoder } from './_util'
import {
  checkProperties,
  deleteItems as deleteItemsAction,
  Item,
  setItems,
  updateItems,
} from '../state/items'
import { AccountMetadata, setAccount } from '../state/account'
import store, { AppDispatch } from '../store'
import { FlockPushSubscription } from '../utils/firebase-types'
import { getAccountId, initAxios } from './common'
import migrateItems from '../state/migrations'
import { setUi } from '../state/ui'

const VAULT_KEY_STORAGE_KEY = 'FlockVaultKey'
const ACCOUNT_STORAGE_KEY = 'FlockVaultAccount'
const VAULT_ITEM_CACHE = 'vaultItemCache'
const VAULT_ITEM_CACHE_TIME = 'vaultItemCacheTime'

function fromBytes(array: ArrayBuffer): string {
  const byteArray = Array.from(new Uint8Array(array))
  const asString = byteArray.map(b => String.fromCharCode(b)).join('')
  return btoa(asString)
}

function fromBytesUrlSafe(array: ArrayBuffer): string {
  return fromBytes(array).replace(/\//g, '_').replace(/\+/g, '-')
}

function toBytes(str: string): Uint8Array {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0)))
}

export interface CryptoResult {
  iv: string,
  cipher: string,
}

export interface VaultImportExportData {
  key: string,
}

export interface VaultConstructorData {
  account: string,
  dispatch: AppDispatch,
  key: CryptoKey,
  keyHash: string,
}

let key: CryptoKey | null = null
let keyHash: string = ''

export function handleVaultError(error: Error, message: string) {
  console.error(error)
  store.dispatch(setUi({
    message: {
      message,
      severity: 'error',
    },
  }))
}

function getKey() {
  if (!key) {
    throw Error('Vault must be initialised before use')
  }
  return key
}

async function updateKeyHash() {
  const keyBuffer = await crypto.subtle.exportKey('raw', getKey())
  const keyHashBytes = await crypto.subtle.digest('SHA-512', keyBuffer)
  keyHash = fromBytes(keyHashBytes)
  initAxios(keyHash)
}

export async function initialiseVault(
  password: string,
  isNewAccount = false,
  iterations?: number,
) {
  const accountId = getAccountId()
  const enc = new Encoder()
  const keyBase = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    'PBKDF2',
    false,
    ['deriveBits', 'deriveKey'],
  )
  key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(accountId),
      iterations: iterations || 100000,
      hash: 'SHA-256',
    },
    keyBase,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  await updateKeyHash()
  if (!isNewAccount) {
    await initialLoadFromVault()
    await storeVault()
  }
}

export async function loadVault() {
  const account = localStorage.getItem(ACCOUNT_STORAGE_KEY)
  if (account) {
    store.dispatch(setAccount({ account, loggedIn: true }))
  }

  const storedKey = localStorage.getItem(VAULT_KEY_STORAGE_KEY)
  if (account && storedKey) {
    key = await crypto.subtle.importKey(
      'raw',
      toBytes(storedKey),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    )
    await updateKeyHash()
    await initialLoadFromVault()
  }
}

export async function storeVault() {
  localStorage.setItem(
    VAULT_KEY_STORAGE_KEY,
    fromBytes(await crypto.subtle.exportKey('raw', getKey())),
  )
  localStorage.setItem(ACCOUNT_STORAGE_KEY, getAccountId())
}

async function initialLoadFromVault() {
  const accountDataPromise = getMetadata()
  const itemsPromise = fetchAll()

  await accountDataPromise
  await itemsPromise

  await migrateItems()
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new Encoder()
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    getKey(),
    enc.encode(plaintext),
  )
  return {
    iv: fromBytes(iv),
    cipher: fromBytes(cipher),
  }
}

export async function decrypt(
  {
    iv,
    cipher,
  }: CryptoResult,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBytes(iv) },
    getKey(),
    toBytes(cipher),
  )
  const dec = new Decoder()
  return dec.decode(plaintext)
}

export function encryptObject(obj: object) {
  return encrypt(JSON.stringify(obj))
}

export async function decryptObject({ iv, cipher }: CryptoResult): Promise<object> {
  return JSON.parse(await decrypt({ iv, cipher }))
}

export function exportData(items: Item[]): Promise<CryptoResult> {
  const data = JSON.stringify(items)
  return encrypt(data)
}

export async function importData(data: CryptoResult): Promise<Item[]> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData)
}

export function storeItems(data: Item | Item[]) {
  if (data instanceof Array) {
    return storeManyItems(data)
  }
  return storeOneItem(data)
}

export async function storeOneItem(item: Item) {
  const checkResult = checkProperties([item])
  if (checkResult.error) {
    throw new Error(checkResult.message)
  }

  store.dispatch(updateItems([item]))
  const { cipher, iv } = await encryptObject(item)
  await vaultPut({
    cipher,
    item: item.id,
    metadata: {
      iv,
      type: item.type,
      modified: new Date().getTime(),
    },
  })
}

export async function storeManyItems(items: Item[]) {
  const checkResult = checkProperties(items)
  if (checkResult.error) {
    throw new Error(checkResult.message)
  }

  store.dispatch(updateItems(items))
  const encrypted = await Promise.all(
    items.map(
      item => encryptObject(item),
    ),
  )
  const modifiedTime = new Date().getTime()

  await vaultPutMany({
    items: encrypted.map(({ cipher, iv }, i) => ({
      account: getAccountId(),
      cipher,
      item: items[i].id,
      metadata: {
        iv,
        type: items[i].type,
        modified: modifiedTime,
      },
    })),
  })
}

export function getItemCacheTime() {
  const rawCache = localStorage.getItem(VAULT_ITEM_CACHE)
  if (!rawCache || rawCache === '[]') {
    return null
  }
  const raw = localStorage.getItem(VAULT_ITEM_CACHE_TIME)
  if (raw) {
    return parseInt(raw)
  }
  return null
}

export async function mergeWithItemCache(itemsPromise: Promise<CachedVaultItem[]>): Promise<VaultItem[]> {
  const rawCache = localStorage.getItem(VAULT_ITEM_CACHE)
  const cachedItems: VaultItem[] = JSON.parse(rawCache || '[]')
  if (cachedItems.length > 0) {
    const cachedMap = new Map(cachedItems.map(item => [item.item, item]))
    const items = await itemsPromise
    const result = items.map(
      item => (item.cipher ? (item as VaultItem) : cachedMap.get(item.item)),
    )
    const filteredResult = result.filter(
      (item): item is NonNullable<typeof item> => item !== undefined,
    )
    const missingIds = (
      items
        .map(item => item.item)
        .filter(id => !filteredResult.some(item => item.item === id))
    )
    if (filteredResult.length !== result.length) {
      console.warn('Some items were missing from the cache!')
      const newItems = await vaultFetchMany({ ids: missingIds }).catch(error => {
        handleVaultError(error, 'Failed to fetch some items from server')
        return [] as VaultItem[]
      })
      filteredResult.push(...newItems)
    }
    setItemCache(filteredResult)
    return filteredResult
  }
  const items = await itemsPromise
  if (items.find(item => !item.cipher)) {
    console.warn('Some items were missing from the cache!')
  } else {
    setItemCache(items as VaultItem[])
  }
  return items as VaultItem[]
}

export function setItemCache(items: VaultItem[]) {
  const raw = JSON.stringify(items)
  localStorage.setItem(VAULT_ITEM_CACHE, raw)
  localStorage.setItem(VAULT_ITEM_CACHE_TIME, new Date().getTime().toString())
}

export function clearItemCache() {
  localStorage.removeItem(VAULT_ITEM_CACHE)
  localStorage.removeItem(VAULT_ITEM_CACHE_TIME)
}

export function checkItemCache() {
  return !!localStorage.getItem(VAULT_ITEM_CACHE_TIME)
}

export async function fetchAll(): Promise<Item[]> {
  const cacheTime = getItemCacheTime()
  const fetchPromise = vaultFetchMany({
    cacheTime,
  }).catch(error => {
    handleVaultError(error, 'Failed to fetch items from server')
    return [] as VaultItem[]
  })
  const mergedFetch = await mergeWithItemCache(fetchPromise)
  const resultPromise = Promise.all(mergedFetch.map(
    item => decryptObject({
      cipher: item.cipher,
      iv: item.metadata.iv,
    }) as Promise<Item>,
  ))
  resultPromise.then(items => store.dispatch(setItems(items)))
  resultPromise.catch(error => {
    handleVaultError(error, 'Failed to decrypt items')
  })
  return resultPromise
}

export function deleteItems(data: string | string[]) {
  if (data instanceof Array) {
    return deleteManyItems(data)
  }
  return deleteOneItem(data)
}

export async function deleteOneItem(itemId: string) {
  store.dispatch(deleteItemsAction([itemId]))
  try {
    await vaultDelete({
      item: itemId,
    })
  } catch (error) {
    return false
  }
  return true
}

export async function deleteManyItems(itemIds: string[]) {
  store.dispatch(deleteItemsAction(itemIds))
  try {
    await vaultDeleteMany({
      items: itemIds,
    })
  } catch (error) {
    return false
  }
  return true
}

export async function setMetadata(metadata: AccountMetadata) {
  store.dispatch(setAccount({ metadata }))
  const { cipher, iv } = await encryptObject(metadata)
  return vaultSetMetadata({
    metadata: { cipher, iv },
  })
}

export async function getMetadata(): Promise<AccountMetadata> {
  const result = await vaultGetMetadata()
  let metadata: AccountMetadata
  try {
    metadata = await decryptObject(result as CryptoResult)
  } catch (error) {
    // Backwards compatibility (10/07/21)
    metadata = result as AccountMetadata
  }
  store.dispatch(setAccount({ metadata }))
  return metadata
}

async function getSubscriptionId(subscriptionToken: string): Promise<string> {
  const enc = new Encoder()
  const buffer = await crypto.subtle.digest('SHA-512', enc.encode(subscriptionToken))
  return fromBytesUrlSafe(buffer)
}

export async function getSubscription(subscriptionToken: string): Promise<FlockPushSubscription | null> {
  const result = await vaultGetSubscription({
    subscriptionId: await getSubscriptionId(subscriptionToken),
  })
  return result
}

export async function setSubscription(subscription: FlockPushSubscription): Promise<void> {
  const result = await vaultSetSubscription({
    subscriptionId: await getSubscriptionId(subscription.token),
    subscription,
  })
  if (!result) {
    throw new Error('Failed to save push notification token to server')
  }
}

export async function deleteSubscription(subscriptionToken: string): Promise<void> {
  const result = await vaultDeleteSubscription({
    subscriptionId: await getSubscriptionId(subscriptionToken),
  })
  if (!result) {
    throw new Error('Failed to delete push notification token from server')
  }
}
