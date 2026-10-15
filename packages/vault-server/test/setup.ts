// DynamoDB Local, as `docker compose` runs it. Create the tables with `yarn initdb`.
process.env.DYNAMODB_ENDPOINT ??= 'http://127.0.0.1:8000'
process.env.ACCOUNTS_TABLE ??= 'FlockAccounts'
process.env.ITEMS_TABLE ??= 'FlockItems'
process.env.SYNC_MESSAGES_TABLE ??= 'FlockSyncMessages'
