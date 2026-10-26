import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb'
import type { VaultTableNames } from './config'

export const ACCOUNT_CURSOR_INDEX = 'AccountCursorIndex'

export type VaultTableDefinition = Pick<
  CreateTableCommandInput,
  'TableName' | 'KeySchema' | 'AttributeDefinitions' | 'GlobalSecondaryIndexes'
>

/** The key schemas and indexes of the vault's tables, for creating them */
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
      TableName: tables.syncMessages,
      KeySchema: [
        { AttributeName: 'syncId', KeyType: 'HASH' },
        { AttributeName: 'cursor', KeyType: 'RANGE' },
      ],
      AttributeDefinitions: [
        { AttributeName: 'syncId', AttributeType: 'S' },
        { AttributeName: 'cursor', AttributeType: 'N' },
        { AttributeName: 'account', AttributeType: 'S' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: ACCOUNT_CURSOR_INDEX,
          KeySchema: [
            { AttributeName: 'account', KeyType: 'HASH' },
            { AttributeName: 'cursor', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    },
  ]
}
