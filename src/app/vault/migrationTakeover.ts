import { useAppStore } from '../../state/store'
import type { MigrationChannelMessage } from '../../migrate/detection'
import { lockVault } from './session'

/**
 * Locks this tab when the migration app starts in another one, so the migration app's engine is the
 * only one running while it works.
 */
export async function handleMigrationMessage(message: MigrationChannelMessage | undefined): Promise<void> {
  if (message?.type !== 'started' || !useAppStore.getState().loggedIn) return
  await lockVault()
  useAppStore.getState().setMessage({
    severity: 'info',
    message: 'Your data is being updated in another tab. Log in again once it has finished.',
  })
}
