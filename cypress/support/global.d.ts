type QueryKeys = typeof import('../../src/api/queryClient').queryKeys

declare global {
  // Cypress window augmentation for tests that call into vault helpers
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    vault?: Promise<typeof import('../../src/api/Vault')>
    mutations?: Promise<typeof import('../../src/api/mutations')>
    hasApiAuthToken?: typeof import('../../src/api/runtime').hasApiAuthToken
    invalidateQuery?: (key: keyof QueryKeys) => Promise<void>
    queryKeys?: QueryKeys
  }
}

export {}
