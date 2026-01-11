type QueryKeys = typeof import('../../src/api/client').queryKeys

declare global {
  // Cypress window augmentation for tests that call into vault helpers
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    vault?: Promise<typeof import('../../src/api/Vault')>
    mutations?: Promise<typeof import('../../src/api/mutations')>
    checkAxios?: typeof import('../../src/api/axios').checkAxios
    invalidateQuery?: (key: AppQueryKey) => Promise<void>
    queryKeys?: QueryKeys
  }

  type AppQueryKey = keyof QueryKeys
}

export {}
