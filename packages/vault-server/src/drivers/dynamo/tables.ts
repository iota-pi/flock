import type { CreateTableCommandInput, GlobalSecondaryIndex } from '@aws-sdk/client-dynamodb'
import type { VaultTableNames } from './config'

export type VaultTableDefinition = Pick<
  CreateTableCommandInput,
  'TableName' | 'KeySchema' | 'AttributeDefinitions' | 'GlobalSecondaryIndexes'
>

/**
 * A global secondary index an app adds to the accounts table, keyed by one string attribute. Records
 * without that attribute are left out, so an app can keep a small index of the accounts it needs to
 * visit rather than scanning them all. Deployments declare the same index in their infrastructure.
 */
export interface AccountIndex {
  name: string
  /** The string attribute the index is keyed by */
  partitionKey: string
  /** The attributes besides the keys that the index holds */
  attributes: string[]
}

function toGlobalSecondaryIndex({ name, partitionKey, attributes }: AccountIndex): GlobalSecondaryIndex {
  return {
    IndexName: name,
    KeySchema: [{ AttributeName: partitionKey, KeyType: 'HASH' }],
    Projection: { ProjectionType: 'INCLUDE', NonKeyAttributes: attributes },
  }
}

/** The key schemas of the vault's tables, and the app's account indexes, for creating them */
export function getVaultTableDefinitions(
  tables: VaultTableNames,
  accountIndexes: readonly AccountIndex[] = [],
): VaultTableDefinition[] {
  return [
    {
      TableName: tables.items,
      KeySchema: [
        { AttributeName: 'account', KeyType: 'HASH' },
        { AttributeName: 'item', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'account', AttributeType: 'S' },
        { AttributeName: 'item', AttributeType: 'S' },
      ],
    },
    {
      TableName: tables.accounts,
      KeySchema: [
        { AttributeName: 'account', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'account', AttributeType: 'S' },
        ...accountIndexes.map(index => ({ AttributeName: index.partitionKey, AttributeType: 'S' as const })),
      ],
      ...(accountIndexes.length > 0 ? { GlobalSecondaryIndexes: accountIndexes.map(toGlobalSecondaryIndex) } : {}),
    },
    {
      TableName: tables.syncLog,
      KeySchema: [
        { AttributeName: 'account', KeyType: 'HASH' },
        { AttributeName: 'seq', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'account', AttributeType: 'S' },
        { AttributeName: 'seq', AttributeType: 'N' },
      ],
    },
    {
      // Rows expire through a TTL on `expiresAt`, which deployments enable on the table
      TableName: tables.loginThrottle,
      KeySchema: [
        { AttributeName: 'key', KeyType: 'HASH' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'key', AttributeType: 'S' },
      ],
    },
  ]
}
