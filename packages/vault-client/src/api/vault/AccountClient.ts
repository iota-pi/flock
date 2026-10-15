import { getVaultTrpcClient } from '../vaultTrpcClient'
import { assertSuccess } from './clientUtils'
import type {
  AccountCreationResponse,
  CreateAccountBody,
} from './clientTypes'
import { DEFAULT_CRYPTO_ITERATIONS, LEGACY_CRYPTO_ITERATIONS } from './util'

export async function createAccount(
  { salt, authToken, saltVersion }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return getVaultTrpcClient().accounts.createAccount.mutate({
    salt,
    authToken,
    iterations: DEFAULT_CRYPTO_ITERATIONS,
    saltVersion,
  })
}

export async function getSecurityParams(
  account: string,
): Promise<{ salt: string, iterations?: number, saltVersion?: number, dataVersion: number }> {
  const response = await getVaultTrpcClient().accounts.getSecurityParams.query({ account })
  return {
    salt: response.salt,
    iterations: response.iterations || LEGACY_CRYPTO_ITERATIONS,
    saltVersion: response.saltVersion,
    dataVersion: response.dataVersion,
  }
}

/**
 * Asks the server to raise the account's data version, once this device's migrations have run.
 * Returns the version it is at and, if it couldn't be raised, why.
 */
export async function raiseDataVersion(account: string): Promise<{ dataVersion: number, blockers: string[] }> {
  const response = await getVaultTrpcClient().accounts.raiseDataVersion.mutate({ account })
  assertSuccess(response, 'raiseDataVersion')
  return { dataVersion: response.dataVersion, blockers: response.blockers }
}

export async function getSession(account: string, authToken: string): Promise<string> {
  const response = await getVaultTrpcClient().accounts.login.mutate({
    account,
    authToken,
  })
  assertSuccess(response, 'getSession')
  if (!response.session) {
    throw new Error('Vault client getSession: missing session')
  }
  return response.session
}

export async function getKeyring(account: string): Promise<string | undefined> {
  const response = await getVaultTrpcClient().accounts.getKeyring.query({ account })
  assertSuccess(response, 'getKeyring')
  return response.keyring
}

export async function updateKeyring(
  account: string,
  keyring: string,
  expectedKeyringVersion?: number,
  keyringVersion?: number,
): Promise<void> {
  const response = await getVaultTrpcClient().accounts.updateKeyring.mutate({
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
  const response = await getVaultTrpcClient().accounts.changePassword.mutate({
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
