import { useAppStore } from '../../state/store'
import type { MigrationChannelMessage } from '../../migrate/detection'

/**
 * Locks this tab when the migration app starts in another one, so the migration app's engine is the
 * only one running while it works.
 */
export async function handleMigrationMessage(message: MigrationChannelMessage | undefined): Promise<void> {
  if (message?.type !== 'started' || !useAppStore.getState().loggedIn) return
  // Imported lazily because session.ts depends on the sync bridge
  const { lockVault } = await import('./session')
  await lockVault()
  useAppStore.getState().setMessage({
    severity: 'info',
    message: 'Your data is being updated in another tab. Log in again once it has finished.',
  })
}
