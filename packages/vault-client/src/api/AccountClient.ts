import { getVaultTrpcClient } from './vaultTrpcClient'
import { assertSuccess } from './clientUtils'
import type {
  AccountCreationResponse,
  CreateAccountBody,
} from './clientTypes'
import type { KdfParams } from '@vault/shared'
import { getLegacyPbkdf2Iterations } from './kdf'
import { retryTransientFailures } from './requestRetry'

export async function createAccount(
  { salt, authToken, saltVersion, kdf, keyring, randomDataKeys }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return getVaultTrpcClient().accounts.createAccount.mutate({
    salt,
    authToken,
    saltVersion,
    kdf,
    keyring,
    randomDataKeys,
  })
}

/**
 * The account's key derivation parameters. With `retry`, transient failures are retried, for a
 * login that has no cached parameters to fall back on.
 */
export async function getSecurityParams(
  account: string,
  { retry = false } = {},
): Promise<{ salt: string, iterations?: number, saltVersion?: number, kdf?: KdfParams, dataVersion: number }> {
  const query = () => getVaultTrpcClient().accounts.getSecurityParams.query({ account })
  const response = retry ? await retryTransientFailures('get security params', query) : await query()
  return {
    salt: response.salt,
    // Accounts from before iterations were stored used the legacy count. Argon2id accounts have none.
    iterations: response.kdf ? undefined : response.iterations || getLegacyPbkdf2Iterations(),
    saltVersion: response.saltVersion,
    ...(response.kdf ? { kdf: response.kdf } : {}),
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

/** The account's encrypted keyring, and whether its data keys were created random (see `randomDataKeys`) */
export async function getKeyring(account: string): Promise<{ keyring?: string, randomDataKeys: boolean }> {
  const response = await getVaultTrpcClient().accounts.getKeyring.query({ account })
  assertSuccess(response, 'getKeyring')
  return { keyring: response.keyring, randomDataKeys: response.randomDataKeys === true }
}

export async function updateKeyring({
  account,
  currentAuthToken,
  keyring,
  expectedKeyringVersion,
  keyringVersion,
}: {
  account: string,
  currentAuthToken: string,
  keyring: string,
  expectedKeyringVersion?: number,
  keyringVersion?: number,
}): Promise<void> {
  const response = await getVaultTrpcClient().accounts.updateKeyring.mutate({
    account,
    currentAuthToken,
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
  newKdf,
  newKeyring,
  saltVersion,
  keyringVersion,
  expectedKeyringVersion,
}: {
  account: string,
  currentAuthToken: string,
  newAuthToken: string,
  newSalt: string,
  newKdf: KdfParams,
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
    newKdf,
    newKeyring,
    saltVersion,
    ...(typeof keyringVersion === 'number' ? { keyringVersion } : {}),
    ...(typeof expectedKeyringVersion === 'number' ? { expectedKeyringVersion } : {}),
  })
  assertSuccess(response, 'changePassword')
}
