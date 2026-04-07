import { syncDB } from '../api/db'

export const ACTIVE_SESSION_TOKEN_KEY = 'active_session_token'

export async function getActiveSessionToken(): Promise<string | null> {
  return (await syncDB.getItem<string>(ACTIVE_SESSION_TOKEN_KEY)) || null
}

export async function setActiveSessionToken(sessionToken: string): Promise<void> {
  await syncDB.setItem(ACTIVE_SESSION_TOKEN_KEY, sessionToken)
}

export async function clearActiveSessionToken(): Promise<void> {
  await syncDB.removeItem(ACTIVE_SESSION_TOKEN_KEY)
}
