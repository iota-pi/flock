import type { WebPushSubscription } from '../../vault/types'
import { useAuthStore } from '../../state/authStore'
import { useToastStore } from '../../state/toastStore'
import {
  clearActiveSessionToken,
  getActiveSessionToken,
  setActiveSessionToken,
} from '../../sync/workerAuthStore'
import { clearManualRecoveryEntries } from '../../sync/manualRecoveryStore'
import { getAccountId } from '../util'
import { setApiAuthToken, setApiSessionExpiredHandler } from '../runtime'
import {
  addPushSubscription as addPushSubscriptionClient,
  createAccount,
  deletePushSubscription as deletePushSubscriptionClient,
  getReminderSettings,
  getSecurityParams,
  getSession,
  recordPrayerCompletion as recordPrayerCompletionClient,
  updateReminderSettings as updateReminderSettingsClient,
} from './client'
import {
  decryptWithKey,
  deriveVaultKey,
  encryptWithKey,
  exportVaultKey,
  hashVaultKey,
  importVaultKey,
  encryptBytesWithKey,
  decryptBytesWithKey,
  type CryptoResult,
} from './crypto'
import type { TRPCError } from '@trpc/server'
import { SyncBridge } from 'src/sync/SyncBridge'
import { readStoredMetadata, VAULT_STORAGE_KEY, VaultStoredMetadata } from './util'

export { createAccount, getSecurityParams, getReminderSettings }
export type { CryptoResult }

export interface VaultImportExportData {
  key: string,
}

export class VaultNotInitializedError extends Error {
  constructor() {
    super('Vault must be initialised before use')
    this.name = 'VaultNotInitializedError'
  }
}

let keyring: Map<string, CryptoKey> = new Map()
let activeKeyVersion = '1'
let keyHash = ''
let session = ''
let isHandlingSessionExpiry = false
let loadVaultInFlight: Promise<void> | null = null

function getActiveKey(): CryptoKey {
  const k = keyring.get(activeKeyVersion)
  if (!k) {
    throw new VaultNotInitializedError()
  }
  return k
}


export function getVaultKey(kver?: string): CryptoKey {
  if (!kver) {
    return getActiveKey()
  }
  const k = keyring.get(kver)
  if (!k) {
    throw new Error(`Vault key version ${kver} not found in keyring`)
  }
  return k
}

export function getVaultSession() {
  return session
}

async function writeStoredMetadata() {
  const keyringData: Record<string, string> = {
    activeVersion: activeKeyVersion,
  }
  for (const [ver, k] of keyring.entries()) {
    keyringData[ver] = await exportVaultKey(k)
  }

  localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify({
    account: getAccountId(),
    key: JSON.stringify(keyringData),
  } satisfies VaultStoredMetadata))
}

function clearStoredMetadata() {
  localStorage.removeItem(VAULT_STORAGE_KEY)
}

async function establishSessionFromKeyHash(nextKeyHash: string) {
  keyHash = nextKeyHash
  session = await getSession(nextKeyHash)
  setApiAuthToken(session)
  await setActiveSessionToken(session)
}

async function handleSessionExpired() {
  if (isHandlingSessionExpiry) {
    return
  }

  isHandlingSessionExpiry = true
  try {
    await signOutVault()
  } finally {
    setTimeout(() => {
      isHandlingSessionExpiry = false
    }, 1000)
  }
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
  const derivedKey = await deriveVaultKey({ password, salt, iterations })
  keyring.clear()
  keyring.set('1', derivedKey)
  activeKeyVersion = '1'
  keyHash = await hashVaultKey(derivedKey)
  return keyHash
}

export async function initWorkerVault(vaultKeyOrKeyring: string) {
  keyring.clear()
  try {
    const keyringData = JSON.parse(vaultKeyOrKeyring)
    if (keyringData && typeof keyringData === 'object' && keyringData.activeVersion) {
      activeKeyVersion = keyringData.activeVersion as string
      for (const [ver, expKey] of Object.entries(keyringData)) {
        if (ver !== 'activeVersion') {
          keyring.set(ver, await importVaultKey(expKey as string))
        }
      }
    } else {
      throw new Error('Not a structured keyring')
    }
  } catch (e) {
    // Legacy single key
    const imported = await importVaultKey(vaultKeyOrKeyring)
    keyring.set('1', imported)
    activeKeyVersion = '1'
  }

  const sessionToken = await getActiveSessionToken()
  if (sessionToken) {
    setApiAuthToken(sessionToken)
  } else {
    console.warn('[SyncWorker] Missing session token for realtime sync; network pushes will not start.')
  }
}

export async function loginVault({
  password,
  salt,
  iterations,
}: {
  password: string,
  salt: string,
  iterations?: number,
}) {
  await initialiseVault({ password, salt, iterations })
  await establishSessionFromKeyHash(keyHash)
  await storeVault()
}

export async function loadVault() {
  if (loadVaultInFlight) {
    return loadVaultInFlight
  }

  loadVaultInFlight = (async () => {
    const { updateAuth } = useAuthStore.getState()
    const { setMessage } = useToastStore.getState()
    const stored = readStoredMetadata()

    try {
      if (stored?.account) {
        updateAuth({ account: stored.account })
      }

      if (stored?.key) {
        keyring.clear()
        try {
          const keyringData = JSON.parse(stored.key)
          if (keyringData && typeof keyringData === 'object' && keyringData.activeVersion) {
            activeKeyVersion = keyringData.activeVersion as string
            for (const [ver, expKey] of Object.entries(keyringData)) {
              if (ver !== 'activeVersion') {
                keyring.set(ver, await importVaultKey(expKey as string))
              }
            }
          } else {
            throw new Error('Not a structured keyring')
          }
        } catch (e) {
          // Legacy single key
          const imported = await importVaultKey(stored.key)
          keyring.set('1', imported)
          activeKeyVersion = '1'
        }

        const nextKeyHash = await hashVaultKey(getActiveKey())
        try {
          await establishSessionFromKeyHash(nextKeyHash)
          setApiSessionExpiredHandler(handleSessionExpired)
          updateAuth({ loggedIn: true })
        } catch (error) {
          if (error instanceof Error && error.name === 'TRPCClientError' && (error as TRPCError).code === 'UNAUTHORIZED') {
            console.error('[vault] loadVault login failed', error)
            await signOutVault()
            setMessage({
              severity: 'error',
              message: 'Login failed. Please sign in again.',
            })
          }
        }
      }
    } finally {
      updateAuth({ initializing: false })
    }
  })().finally(() => {
    loadVaultInFlight = null
  })

  return loadVaultInFlight
}

export async function storeVault() {
  await writeStoredMetadata()
}

export async function signOutVault() {
  const { updateAuth } = useAuthStore.getState()
  keyring.clear()
  activeKeyVersion = '1'
  keyHash = ''
  session = ''
  setApiAuthToken('')

  clearStoredMetadata()
  try {
    await SyncBridge.clearAutomergeDocStore()
  } catch (err) {
    if (!(err instanceof Error && err.message.includes('not initialized'))) {
      throw err
    }
  }
  await clearActiveSessionToken()
  await clearManualRecoveryEntries()

  updateAuth({ account: '', loggedIn: false })
}

export async function encrypt(plaintext: string): Promise<CryptoResult> {
  return encryptWithKey(getActiveKey(), plaintext, activeKeyVersion)
}

export async function decrypt(data: CryptoResult): Promise<string> {
  const kver = data.kver || '1'
  return decryptWithKey(getVaultKey(kver), data)
}

export async function decryptObject({ iv, cipher, kver }: CryptoResult): Promise<object> {
  return JSON.parse(await decrypt({ iv, cipher, kver }))
}

export function exportData<T>(payload: T): Promise<CryptoResult> {
  return encrypt(JSON.stringify(payload))
}

export async function importData<T = unknown>(data: CryptoResult): Promise<T> {
  const plainData = await decrypt(data)
  return JSON.parse(plainData) as T
}

export async function encryptBytes(bytes: Uint8Array): Promise<CryptoResult> {
  return encryptBytesWithKey(getActiveKey(), bytes, activeKeyVersion)
}

export async function decryptBytes(data: CryptoResult): Promise<Uint8Array> {
  const kver = data.kver || '1'
  return decryptBytesWithKey(getVaultKey(kver), data)
}

export async function addPushSubscription(subscription: WebPushSubscription): Promise<void> {
  await addPushSubscriptionClient(subscription)
}

export async function deletePushSubscription(endpoint: string): Promise<void> {
  await deletePushSubscriptionClient(endpoint)
}

export async function updateReminderSettings(
  settings: { reminderEnabled: boolean, reminderTime: string, reminderTimezone: string },
): Promise<void> {
  await updateReminderSettingsClient(settings)
}

export async function recordPrayerCompletion(completedAt = Date.now()): Promise<void> {
  await recordPrayerCompletionClient(completedAt)
}
