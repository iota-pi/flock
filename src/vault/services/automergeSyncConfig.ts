export type AutomergeSyncConfig = {
  awsRegion: string
  itemsTable: string
  syncMessagesTable: string
}

export function resolveAutomergeSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomergeSyncConfig {
  return {
    itemsTable: env.ITEMS_TABLE || 'FlockItems',
    syncMessagesTable: env.SYNC_MESSAGES_TABLE || 'FlockSyncMessages',
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-southeast-2',
  }
}