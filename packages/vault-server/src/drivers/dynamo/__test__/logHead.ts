import { GetCommand } from '@aws-sdk/lib-dynamodb'
import type DynamoDriver from '../driver'

/** The last seq the account's log has used, read from its head row (0 when it's empty) */
export async function readLogHead(driver: DynamoDriver, account: string): Promise<number> {
  const { Item } = await driver.client.send(new GetCommand({
    TableName: driver.tables.syncLog,
    Key: { account, seq: 0 },
    ConsistentRead: true,
  }))
  return (Item?.head as number | undefined) ?? 0
}
