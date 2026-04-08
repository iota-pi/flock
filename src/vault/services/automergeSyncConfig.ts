export type AutomergeSyncConfig = {
  awsRegion: string
  itemsTable: string
}

export function resolveAutomergeSyncConfig(
  env: NodeJS.ProcessEnv = process.env,
): AutomergeSyncConfig {
  return {
    itemsTable: env.ITEMS_TABLE || 'FlockItems',
    awsRegion: env.AWS_REGION || env.AWS_DEFAULT_REGION || 'ap-southeast-2',
  }
}