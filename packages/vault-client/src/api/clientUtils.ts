export function assertSuccess(response: { success: boolean }, operation: string): void {
  if (!response.success) {
    throw new Error(`Vault client ${operation} operation failed`)
  }
}