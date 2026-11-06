import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb'
import type { VaultTableNames } from './config'

export type VaultTableDefinition = Pick<CreateTableCommandInput, 'TableName' | 'KeySchema' | 'AttributeDefinitions'>

/** The key schemas of the vault's tables, for creating them */
export function getVaultTableDefinitions(tables: VaultTableNames): VaultTableDefinition[] {
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
      ],
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
  ]
}
