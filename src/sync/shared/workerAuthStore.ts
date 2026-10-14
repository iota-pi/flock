import localforage from 'localforage'
import { getVaultStorageNames } from './storageNames'

const ACTIVE_SESSION_TOKEN_KEY = 'active_session_token'

let authDB: LocalForage | null = null

function getAuthDB(): LocalForage {
  if (!authDB) {
    authDB = localforage.createInstance({ name: getVaultStorageNames().authDatabase })
  }
  return authDB
}

export async function getActiveSessionToken(): Promise<string | null> {
  return (await getAuthDB().getItem<string>(ACTIVE_SESSION_TOKEN_KEY)) || null
}

export async function setActiveSessionToken(sessionToken: string): Promise<void> {
  await getAuthDB().setItem(ACTIVE_SESSION_TOKEN_KEY, sessionToken)
}

export async function clearActiveSessionToken(): Promise<void> {
  await getAuthDB().removeItem(ACTIVE_SESSION_TOKEN_KEY)
}
