import { useAuthStore } from '../state/authStore'

export function getAccountId() {
  const account = useAuthStore.getState().account
  if (!account) {
    throw new Error('Account ID not set; cannot use API without account ID.')
  }
  return account
}
