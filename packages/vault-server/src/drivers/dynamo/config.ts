import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb'

export interface VaultTableNames {
  accounts: string
  items: string
  syncMessages: string
}

const TABLE_NAME_ENV_VARS: Record<keyof VaultTableNames, string> = {
  accounts: 'ACCOUNTS_TABLE',
  items: 'ITEMS_TABLE',
  syncMessages: 'SYNC_MESSAGES_TABLE',
}

/**
 * Resolves table names from explicit options, falling back to the ACCOUNTS_TABLE, ITEMS_TABLE
 * and SYNC_MESSAGES_TABLE environment variables.
 */
export function resolveVaultTableNames(tables: Partial<VaultTableNames> = {}): VaultTableNames {
  const resolved = {} as VaultTableNames
  for (const key of Object.keys(TABLE_NAME_ENV_VARS) as Array<keyof VaultTableNames>) {
    const envVar = TABLE_NAME_ENV_VARS[key]
    const name = tables[key] ?? process.env[envVar]
    if (!name) {
      throw new Error(`Missing DynamoDB table name for "${key}". Pass it to DynamoDriver or set ${envVar}.`)
    }
    resolved[key] = name
  }
  return resolved
}

export function getConnectionParams(options?: DynamoDBClientConfig): DynamoDBClientConfig {
  const customEndpoint = !!process.env.DYNAMODB_ENDPOINT
  // Against AWS, fail a stalled connection or socket quickly so the SDK retries it within the
  // Lambda's time limit. `requestTimeout` is how long the socket may go idle, not the whole request's
  // duration. A local DynamoDB can be slow under test load, and a retry after a write that did land
  // fails its condition, so it gets no timeouts.
  const endpointArgs: DynamoDBClientConfig = customEndpoint ? {
    credentials: { accessKeyId: 'foo', secretAccessKey: 'bar' },
    endpoint: process.env.DYNAMODB_ENDPOINT,
    region: 'local',
  } : {
    requestHandler: {
      connectionTimeout: 1_000,
      requestTimeout: 3_000,
    },
  }
  // Without a local endpoint, the region resolves as the AWS SDK's always does: Lambda sets AWS_REGION
  return {
    apiVersion: '2012-08-10',
    ...endpointArgs,
    ...options,
  }
}
