import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import { assertSuccess } from './clientUtils'
import type {
  AccountCreationResponse,
  CreateAccountBody,
} from './clientTypes'
import { DEFAULT_CRYPTO_ITERATIONS } from './util'

export async function createAccount(
  { salt, authToken }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return trpcClient.accounts.createAccount.mutate({
    salt,
    authToken,
    iterations: DEFAULT_CRYPTO_ITERATIONS,
  })
}

export async function getSecurityParams(): Promise<{ salt: string, iterations?: number }> {
  const account = getAccountId()
  const response = await trpcClient.accounts.getSecurityParams.query({ account })
  return { salt: response.salt, iterations: response.iterations }
}

export async function getSession(authToken: string): Promise<string> {
  const response = await trpcClient.accounts.login.mutate({
    account: getAccountId(),
    authToken,
  })
  assertSuccess(response, 'getSession')
  if (!response.session) {
    throw new Error('Vault client getSession: missing session')
  }
  return response.session
}

export async function recordPrayerCompletion(completedAt: number): Promise<void> {
  const response = await trpcClient.accounts.recordPrayerCompletion.mutate({
    account: getAccountId(),
    completedAt,
  })
  assertSuccess(response, 'recordPrayerCompletion')
}

export async function getKeyring(): Promise<string | undefined> {
  const account = getAccountId()
  const response = await trpcClient.accounts.getKeyring.query({ account })
  assertSuccess(response, 'getKeyring')
  return response.keyring
}

export async function updateKeyring(keyring: string): Promise<void> {
  const account = getAccountId()
  const response = await trpcClient.accounts.updateKeyring.mutate({
    account,
    keyring,
  })
  assertSuccess(response, 'updateKeyring')
}