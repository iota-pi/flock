// vitest.config.ts points DYNAMODB_ENDPOINT at the test DynamoDB Local, and vitest.dynamodb.ts
// creates these tables there
process.env.ACCOUNTS_TABLE ??= 'FlockAccounts'
process.env.ITEMS_TABLE ??= 'FlockItems'
process.env.SYNC_MESSAGES_TABLE ??= 'FlockSyncMessages'
