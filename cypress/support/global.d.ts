declare global {
  // Cypress window augmentation for tests that call into vault helpers
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    vault?: Promise<typeof import('@vault/client')>
    mutations?: Promise<typeof import('../../src/features/items/mutations/itemMutations')>
    syncBridge?: Promise<typeof import('../../src/app/vault/syncBridge').SyncBridge>
    hasApiAuthToken?: typeof import('@vault/client/runtime').hasApiAuthToken
  }
}

export {}
