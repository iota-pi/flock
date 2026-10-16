import { router, protectedProcedure } from '@vault/server'
import type { BaseDriver, VaultAccountWithAuth } from '@vault/server'
import { AccountInputSchema } from '@vault/shared'
import type { FlockAccountFields } from '../../types'

/** The plaintext settings Flock stored on the account record before the encrypted settings document */
function readLegacySettings(accountData: VaultAccountWithAuth): Record<string, unknown> {
  return (accountData as VaultAccountWithAuth & FlockAccountFields).metadata ?? {}
}

async function clearLegacySettings(vault: BaseDriver, account: string): Promise<void> {
  await vault.updateAccountData<FlockAccountFields>({ account, metadata: {} })
}

/**
 * Procedures for legacy formats, called only by the migration app (`src/migrate/`). They go when
 * the level they serve is retired (see docs/vault-extraction.md).
 */
export const migrationRouter = router({
  getLegacySettings: protectedProcedure
    .input(AccountInputSchema)
    .query(async ({ ctx }) => {
      return { success: true, metadata: readLegacySettings(ctx.accountData) }
    }),

  clearLegacySettings: protectedProcedure
    .input(AccountInputSchema)
    .mutation(async ({ ctx, input }) => {
      await clearLegacySettings(ctx.vault, input.account)
      return { success: true }
    }),
})
