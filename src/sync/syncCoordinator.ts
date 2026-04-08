import { SyncCoordinatorService, type SyncCoordinatorOptions } from './syncCoordinatorService'

const syncCoordinatorService = new SyncCoordinatorService()

export function startSyncCoordinator(options: SyncCoordinatorOptions): void {
  syncCoordinatorService.start(options)
}

export function stopSyncCoordinator(): void {
  syncCoordinatorService.stop()
}