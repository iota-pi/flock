import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import type { DynamoDBDocumentClient, ScanCommandOutput } from '@aws-sdk/lib-dynamodb'

// Older rows may mark deletion with a top-level attribute, which the manifest also reads
const IS_DELETED = '#metadata.#deleted = :true OR #deleted = :true'
const HAS_PAYLOAD = 'attribute_exists(#snapshot) OR attribute_exists(#cipher)'
const CONDITION_NAMES = {
  '#metadata': 'metadata',
  '#deleted': 'deleted',
  '#snapshot': 'snapshot',
  '#cipher': 'cipher',
}
const VALUES = { ':true': true }

export interface DropDeletedItemPayloadsResult {
  /** Deleted items that still held a snapshot payload or a legacy cipher */
  found: number
  /** How many of those were stripped (0 for a dry run) */
  dropped: number
}

/**
 * Removes the content of deleted items: the snapshot and any legacy `cipher`. Deletion is terminal,
 * and clients learn of it from the manifest (`metadata.deleted` or the older top-level `deleted`),
 * so nothing reads that content again. Keeping it meant content from before the Argon2id migration
 * stayed under the password-derived v1 key indefinitely (docs/local-encryption.md, "Non-goals and
 * limits"). The row keeps its metadata, `version` and `modifiedAt`, so the manifest is unchanged and
 * no device re-fetches or re-uploads the item.
 *
 * Idempotent: a stripped row no longer matches, so a run that times out can be started again.
 */
export async function dropDeletedItemPayloads(
  client: DynamoDBDocumentClient,
  table: string,
  { dryRun = false }: { dryRun?: boolean } = {},
): Promise<DropDeletedItemPayloadsResult> {
  let lastEvaluatedKey: ScanCommandOutput['LastEvaluatedKey'] | undefined
  let found = 0
  let dropped = 0
  do {
    const response = await client.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: '#account, #item',
      FilterExpression: `(${IS_DELETED}) AND (${HAS_PAYLOAD})`,
      ExpressionAttributeNames: { ...CONDITION_NAMES, '#account': 'account', '#item': 'item' },
      ExpressionAttributeValues: VALUES,
      ExclusiveStartKey: lastEvaluatedKey,
    }))

    for (const row of response.Items ?? []) {
      found += 1
      if (dryRun) continue
      await client.send(new UpdateCommand({
        TableName: table,
        Key: { account: row.account, item: row.item },
        UpdateExpression: 'REMOVE #snapshot, #cipher',
        // Deletion is terminal, so this only guards against creating a row that no longer exists
        ConditionExpression: `attribute_exists(#item) AND (${IS_DELETED})`,
        ExpressionAttributeNames: { ...CONDITION_NAMES, '#item': 'item' },
        ExpressionAttributeValues: VALUES,
      }))
      dropped += 1
    }
    lastEvaluatedKey = response.LastEvaluatedKey
  } while (lastEvaluatedKey)

  return { found, dropped }
}
