import { runStorageOperation } from '../../utils/storageManager'
import { getSyncMetadataStorage, SYNC_METADATA_KEYS } from './syncMetadataStorage'

/** Where this device has reached in the account's log */
export interface LogPosition {
  /** The highest seq processed */
  cursor: number
  /** The server's clock at the last pull that reached the end of the log, if there has been one */
  lastPullAt: number | null
}

export class LogCursorStore {
  private readonly storage: LocalForage

  constructor(accountId: string) {
    this.storage = getSyncMetadataStorage(accountId)
  }

  async load(): Promise<LogPosition> {
    const [cursor, lastPullAt] = await Promise.all([
      this.storage.getItem<number>(SYNC_METADATA_KEYS.LOG_CURSOR),
      this.storage.getItem<number>(SYNC_METADATA_KEYS.LOG_LAST_PULL_AT),
    ])
    return { cursor: cursor ?? 0, lastPullAt: lastPullAt ?? null }
  }

  async save({ cursor, lastPullAt }: LogPosition): Promise<void> {
    await runStorageOperation(async () => {
      await this.storage.setItem(SYNC_METADATA_KEYS.LOG_CURSOR, cursor)
      if (lastPullAt !== null) {
        await this.storage.setItem(SYNC_METADATA_KEYS.LOG_LAST_PULL_AT, lastPullAt)
      }
    })
  }
}
