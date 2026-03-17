import type { AccountState } from '../account'

export function setAccountState(
  current: AccountState,
  payload: Partial<AccountState>,
): AccountState {
  return {
    ...current,
    ...payload,
  }
}
