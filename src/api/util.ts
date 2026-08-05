import { useAppStore } from '../state/store'

export function getAccountId() {
  const account = useAppStore.getState().account
  if (!account) {
    throw new Error('Account ID not set; cannot use API without account ID.')
  }
  return account
}
