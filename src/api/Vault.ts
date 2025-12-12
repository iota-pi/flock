import {
  vaultDelete,
  vaultDeleteMany,
  vaultDeleteSubscription,
  vaultGetMetadata,
  vaultGetSession,
  vaultGetSubscription,
  vaultPut,
  vaultPutMany,
  vaultSetMetadata,
  vaultSetSubscription,
} from './VaultAPI'
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
import { initAxios, setSessionExpiredHandler } from './axios'
import { getAccountId } from './util'
import migrateItems from '../state/migrations'
import { setUi } from '../state/ui'
import { queryClient, queryKeys, fetchItems } from './queries'

export const VAULT_KEY_STORAGE_KEY = 'FlockVaultKey'
export const ACCOUNT_STORAGE_KEY = 'FlockVaultAccount'

function fromBytes(array: ArrayBuffer): string {
  const byteArray = Array.from(new Uint8Array(array))
  const asString = byteArray.map(b => String.fromCharCode(b)).join('')
  return btoa(asString)
}

function fromBytesUrlSafe(array: ArrayBuffer): string {
  return fromBytes(array).replace(/\//g, '_').replace(/\+/g, '-')
}

function toBytes(str: string): ArrayBuffer {
  return new Uint8Array(atob(str).split('').map(c => c.charCodeAt(0))).buffer
}

export function getSalt() {
  const saltArray = new Uint8Array(16)
  crypto.getRandomValues(saltArray)
  return fromBytes(saltArray.buffer)
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
let session: string = ''

export function handleVaultError(error: Error, message: string) {
  if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
    return
  }
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
  return keyHash
}

export async function loginVault({
  password,
  salt,
}: {
  password: string,
  salt: string,
}) {
  await initialiseVault({ password, salt })
  session = await vaultGetSession(keyHash)
  initAxios(session)
  await initialLoadFromVault()
  await storeVault()
}

export async function initialiseVault({
  password,
  iterations,
  salt,
}: {
  password: string,
  isNewAccount?: boolean,
  iterations?: number,
  salt: string,
}) {
  const enc = new TextEncoder()
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
      salt: enc.encode(salt),
      iterations: iterations || 100000,
      hash: 'SHA-256',
    },
    keyBase,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
  return updateKeyHash()
}

let isHandlingSessionExpiry = false

function handleSessionExpired() {
  // Prevent multiple simultaneous session expiry handlers
  if (isHandlingSessionExpiry) return
  isHandlingSessionExpiry = true

  signOutVault()
  store.dispatch(setUi({
    message: {
      message: 'Your session has expired. Please log in again.',
      severity: 'warning',
    },
  }))

  // Reset flag after a short delay to allow re-triggering if needed
  setTimeout(() => {
    isHandlingSessionExpiry = false
  }, 1000)
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
    session = await vaultGetSession(keyHash)
    initAxios(session)
    setSessionExpiredHandler(handleSessionExpired)

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
  // Use TanStack Query to fetch data - it handles caching automatically
  const [metadata, items] = await Promise.all([
    queryClient.fetchQuery({
      queryKey: queryKeys.metadata,
      queryFn: async () => {
        const result = await vaultGetMetadata()
        try {
          return await decryptObject(result as CryptoResult) as AccountMetadata
        } catch (error) {
          if (result && 'cipher' in result && 'iv' in result) {
            throw error
          }
          return result as AccountMetadata
        }
      },
    }).catch(error => {
      handleVaultError(error, 'Failed to fetch account metadata from server')
      return {} as AccountMetadata
    }),
    queryClient.fetchQuery({
      queryKey: queryKeys.items,
      queryFn: fetchItems,
    }).catch(error => {
      handleVaultError(error, 'Failed to fetch items from server')
      return [] as Item[]
    }),
  ])

  // Sync to Redux for backward compatibility with existing selectors
  store.dispatch(setAccount({ metadata }))
  store.dispatch(setItems(items as Item[]))

  await migrateItems()
}

export function signOutVault() {
  key = null
  keyHash = ''
  initAxios('')
  store.dispatch(setItems([]))
  store.dispatch(setAccount({ account: '', loggedIn: false, metadata: {} }))
  localStorage.removeItem(VAULT_KEY_STORAGE_KEY)
  localStorage.removeItem(ACCOUNT_STORAGE_KEY)
  // Clear TanStack Query cache
  queryClient.clear()
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const enc = new TextEncoder()
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    getKey(),
    enc.encode(plaintext),
  )
  return {
    iv: fromBytes(iv.buffer),
    cipher: fromBytes(cipher),
  }
}

export async function decrypt(
  {
    iv,
    cipher,
  }: CryptoResult,
): Promise<string> {
  const key = getKey()
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toBytes(iv) },
    key,
    toBytes(cipher),
  )
  const dec = new TextDecoder()
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

  // Optimistically update Redux and query cache
  store.dispatch(updateItems([item]))
  queryClient.setQueryData<Item[]>(queryKeys.items, old => {
    if (!old) return [item]
    const next = [...old]
    const idx = next.findIndex(i => i.id === item.id)
    if (idx >= 0) next[idx] = item
    else next.push(item)
    return next
  })
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

  // Ensure TanStack Query stays in sync
  queryClient.invalidateQueries({ queryKey: queryKeys.items })
}

export async function storeManyItems(items: Item[]) {
  const checkResult = checkProperties(items)
  if (checkResult.error) {
    throw new Error(checkResult.message)
  }

  // Optimistically update Redux and query cache
  store.dispatch(updateItems(items))
  queryClient.setQueryData<Item[]>(queryKeys.items, old => {
    if (!old) return items
    const map = new Map(old.map(i => [i.id, i]))
    for (const item of items) {
      map.set(item.id, item)
    }
    return Array.from(map.values())
  })
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

  // Ensure TanStack Query stays in sync
  queryClient.invalidateQueries({ queryKey: queryKeys.items })
}

// Fetch all items - TanStack Query handles caching
export async function fetchAll(): Promise<Item[]> {
  const items = await queryClient.fetchQuery({
    queryKey: queryKeys.items,
    queryFn: fetchItems,
  })
  store.dispatch(setItems(items as Item[]))
  return items as Item[]
}

export function deleteItems(data: string | string[]) {
  if (data instanceof Array) {
    return deleteManyItems(data)
  }
  return deleteOneItem(data)
}

export async function deleteOneItem(itemId: string) {
  store.dispatch(deleteItemsAction([itemId]))
  queryClient.setQueryData<Item[]>(queryKeys.items, old => (
    old ? old.filter(item => item.id !== itemId) : []
  ))
  return vaultDelete({
    item: itemId,
  }).catch(error => {
    handleVaultError(error, 'Failed to delete item from server')
    return false
  }).then(() => true)
    .finally(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.items })
    })
}

export async function deleteManyItems(itemIds: string[]) {
  store.dispatch(deleteItemsAction(itemIds))
  queryClient.setQueryData<Item[]>(queryKeys.items, old => (
    old ? old.filter(item => !itemIds.includes(item.id)) : []
  ))
  return vaultDeleteMany({
    items: itemIds,
  }).catch(error => {
    handleVaultError(error, 'Failed to delete item from server')
    return false
  }).then(() => true)
    .finally(() => {
      queryClient.invalidateQueries({ queryKey: queryKeys.items })
    })
}

export async function setMetadata(metadata: AccountMetadata) {
  store.dispatch(setAccount({ metadata }))
  const { cipher, iv } = await encryptObject(metadata)
  return vaultSetMetadata({
    cipher,
    iv,
  })
}

export async function getMetadata(): Promise<AccountMetadata> {
  const result = await vaultGetMetadata()
  let metadata: AccountMetadata
  try {
    metadata = await decryptObject(result as CryptoResult)
  } catch (error) {
    if (result && 'cipher' in result && 'iv' in result) {
      throw error
    }
    // Backwards compatibility (10/07/21)
    metadata = result as AccountMetadata
  }
  store.dispatch(setAccount({ metadata }))
  return metadata
}

async function getSubscriptionId(subscriptionToken: string): Promise<string> {
  const enc = new TextEncoder()
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
  await vaultSetSubscription({
    subscriptionId: await getSubscriptionId(subscription.token),
    subscription,
  })
}

export async function deleteSubscription(subscriptionToken: string): Promise<void> {
  await vaultDeleteSubscription({
    subscriptionId: await getSubscriptionId(subscriptionToken),
  })
}
