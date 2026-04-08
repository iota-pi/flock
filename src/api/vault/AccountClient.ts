import { trpcClient } from '../trpcClient'
import { getAccountId } from '../util'
import { assertSuccess } from './clientUtils'
import type {
  AccountCreationResponse,
  CreateAccountBody,
} from './clientTypes'

export async function createAccount(
  { salt, authToken }: CreateAccountBody,
): Promise<AccountCreationResponse> {
  return trpcClient.accounts.createAccount.mutate({ salt, authToken })
}

export async function getSalt(): Promise<string> {
  const response = await trpcClient.accounts.getSalt.query({ account: getAccountId() })
  assertSuccess(response, 'getSalt')
  if (!response.salt) {
    throw new Error('Vault client getSalt: missing salt')
  }
  return response.salt
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