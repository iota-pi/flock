declare global {
  // Cypress window augmentation for tests that call into vault helpers
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Window {
    vault?: Promise<typeof import('../../src/api/Vault')>
    checkAxios?: typeof import('../../src/api/axios').checkAxios
  }
}

export {}
