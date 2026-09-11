import { getTrpcClient } from '../trpcClient'
import { assertSuccess } from './clientUtils'
import type {
  AccountCreationResponse,
  CreateAccountBody,
} from './clientTypes'
import { DEFAULT_CRYPTO_ITERATIONS, LEGACY_CRYPTO_ITERATIONS } from './util'

export async function createAccount(
  { salt, authToken, saltVersion }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return getTrpcClient().accounts.createAccount.mutate({
    salt,
    authToken,
    iterations: DEFAULT_CRYPTO_ITERATIONS,
    saltVersion,
  })
}

export async function getSecurityParams(account: string): Promise<{ salt: string, iterations?: number, saltVersion?: number }> {
  const response = await getTrpcClient().accounts.getSecurityParams.query({ account })
  return {
    salt: response.salt,
    iterations: response.iterations || LEGACY_CRYPTO_ITERATIONS,
    saltVersion: response.saltVersion,
  }
}

export async function getSession(account: string, authToken: string): Promise<string> {
  const response = await getTrpcClient().accounts.login.mutate({
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
  const response = await getTrpcClient().accounts.recordPrayerCompletion.mutate({
    account,
    completedAt,
  })
  assertSuccess(response, 'recordPrayerCompletion')
}

export async function getKeyring(account: string): Promise<string | undefined> {
  const response = await getTrpcClient().accounts.getKeyring.query({ account })
  assertSuccess(response, 'getKeyring')
  return response.keyring
}

export async function updateKeyring(
  account: string,
  keyring: string,
  expectedKeyringVersion?: number,
  keyringVersion?: number,
): Promise<void> {
  const response = await getTrpcClient().accounts.updateKeyring.mutate({
    account,
    keyring,
    ...(typeof expectedKeyringVersion === 'number' ? { expectedKeyringVersion } : {}),
    ...(typeof keyringVersion === 'number' ? { keyringVersion } : {}),
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
  keyringVersion,
  expectedKeyringVersion,
}: {
  account: string,
  currentAuthToken: string,
  newAuthToken: string,
  newSalt: string,
  newIterations: number,
  newKeyring: string,
  saltVersion?: number,
  keyringVersion?: number,
  expectedKeyringVersion?: number,
}): Promise<void> {
  const response = await getTrpcClient().accounts.changePassword.mutate({
    account,
    currentAuthToken,
    newAuthToken,
    newSalt,
    newIterations,
    newKeyring,
    saltVersion,
    ...(typeof keyringVersion === 'number' ? { keyringVersion } : {}),
    ...(typeof expectedKeyringVersion === 'number' ? { expectedKeyringVersion } : {}),
  })
  assertSuccess(response, 'changePassword')
}

export async function getMetadata(account: string): Promise<Record<string, unknown> | undefined> {
  const response = await getTrpcClient().accounts.getMetadata.query({ account })
  assertSuccess(response, 'getMetadata')
  return response.metadata
}

export async function updateMetadata(
  account: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const response = await getTrpcClient().accounts.updateMetadata.mutate({
    account,
    metadata,
  })
  assertSuccess(response, 'updateMetadata')
}