// The DynamoDB driver, `@vault/server/dynamo`

export { default } from './driver'
export type { DynamoDriverOptions } from './driver'
export { getConnectionParams, resolveVaultTableNames, type VaultTableNames } from './config'
