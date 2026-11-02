import { useAppStore } from '../state/store'

export function getAccountId() {
  const account = useAppStore.getState().account
  if (!account) {
    throw new Error('Account ID not set; cannot use API without account ID.')
  }
  return account
}

export function assertSuccess(response: { success: boolean }, operation: string): void {
  if (!response.success) {
    throw new Error(`API ${operation} operation failed`)
  }
}
