import { trpcClient } from '../trpcClient'
import { assertSuccess } from './clientUtils'
import type {
  AccountCreationResponse,
  CreateAccountBody,
} from './clientTypes'
import { DEFAULT_CRYPTO_ITERATIONS, LEGACY_CRYPTO_ITERATIONS } from './util'

export async function createAccount(
  { salt, authToken, saltVersion }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return trpcClient.accounts.createAccount.mutate({
    salt,
    authToken,
    iterations: DEFAULT_CRYPTO_ITERATIONS,
    saltVersion,
  })
}

export async function getSecurityParams(account: string): Promise<{ salt: string, iterations?: number, saltVersion?: number }> {
  const response = await trpcClient.accounts.getSecurityParams.query({ account })
  return {
    salt: response.salt,
    iterations: response.iterations || LEGACY_CRYPTO_ITERATIONS,
    saltVersion: response.saltVersion,
  }
}

export async function getSession(account: string, authToken: string): Promise<string> {
  const response = await trpcClient.accounts.login.mutate({
    account,
    authToken,
  })
  assertSuccess(response, 'getSession')
  if (!response.session) {
    throw new Error('Vault client getSession: missing session')
  }
  return response.session
}

export async function recordPrayerCompletion(account: string, completedAt: number): Promise<void> {
  const response = await trpcClient.accounts.recordPrayerCompletion.mutate({
    account,
    completedAt,
  })
  assertSuccess(response, 'recordPrayerCompletion')
}

export async function getKeyring(account: string): Promise<string | undefined> {
  const response = await trpcClient.accounts.getKeyring.query({ account })
  assertSuccess(response, 'getKeyring')
  return response.keyring
}

export async function updateKeyring(account: string, keyring: string): Promise<void> {
  const response = await trpcClient.accounts.updateKeyring.mutate({
    account,
    keyring,
  })
  assertSuccess(response, 'updateKeyring')
}

export async function changePassword({
  account,
  currentAuthToken,
  newAuthToken,
  newSalt,
  newIterations,
  newKeyring,
  saltVersion,
}: {
  account: string,
  currentAuthToken: string,
  newAuthToken: string,
  newSalt: string,
  newIterations: number,
  newKeyring: string,
  saltVersion?: number,
}): Promise<void> {
  const response = await trpcClient.accounts.changePassword.mutate({
    account,
    currentAuthToken,
    newAuthToken,
    newSalt,
    newIterations,
    newKeyring,
    saltVersion,
  })
  assertSuccess(response, 'changePassword')
}