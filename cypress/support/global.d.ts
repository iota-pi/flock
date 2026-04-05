declare global {
  // Cypress window augmentation for tests that call into vault helpers
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    vault?: Promise<typeof import('../../src/api/vault/index')>
    mutations?: Promise<typeof import('../../src/api/localFirstItemMutations')>
    hasApiAuthToken?: typeof import('../../src/api/runtime').hasApiAuthToken
    invalidateQuery?: (key: 'items' | 'metadata') => Promise<void>
  }
}

export {}
