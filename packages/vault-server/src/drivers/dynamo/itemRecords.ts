import {
  BatchGetCommand,
  type BatchGetCommandInput,
  UpdateCommand,
  type UpdateCommandOutput,
} from '@aws-sdk/lib-dynamodb'
import { chunk, CryptoResultSchema, type ItemId, type ManifestEntry } from '@vault/shared'
import type { BaseData, FetchedVaultItem, ItemFormatSummary, SetItemResult, VaultItem } from '../vaultDriver'
import type { VaultTableNames } from './config'
import { buildUpdateParams, partitionKeyCondition, projection, RawUpdateValue } from './expressions'
import { sendBatchWithRetry } from './batchRetry'
import { fromStoredItem, storedItemSize, toStoredItem, validateItem } from './items'
import { queryAll, sendConditional, type DynamoContext } from './commands'

const FETCH_BATCH_SIZE = 100

const ITEM_DATA_PROJECTION = projection(['item', 'metadata', 'cipher', 'snapshot', 'version'])

export async function setItem({ client, tables }: DynamoContext, item: VaultItem): Promise<SetItemResult> {
  const itemToPersist = toStoredItem(item)

  // Measured as stored, with the snapshot in binary. Clients limit its base64 text, which is
  // longer, so the server never rejects a snapshot that a client's own size check let through.
  validateItem(itemToPersist)

  // Deletion is terminal. A snapshot from a device that hasn't seen the delete yet still replaces
  // the stored one (hydration merges, so that is harmless), but must keep the item deleted.
  if (itemToPersist.metadata.deleted !== true) {
    const update = itemUpdate(itemToPersist)
    const written = await sendConditional(client, updateItemCommand(tables, itemToPersist, update, { unlessDeleted: true }))
    if (written) {
      return writeResult(itemToPersist, update, written)
    }
  }
  const tombstone = { ...itemToPersist, metadata: { ...itemToPersist.metadata, deleted: true } }
  const update = itemUpdate(tombstone)
  return writeResult(tombstone, update, await client.send(updateItemCommand(tables, tombstone, update)))
}

/** What writing an item sets and removes */
interface ItemUpdate {
  set: Record<string, unknown>
  remove: string[]
}

function itemUpdate(item: VaultItem): ItemUpdate {
  const modifiedAt = typeof item.metadata.modified === 'number'
    ? item.metadata.modified
    : Date.now()
  // A snapshot supersedes the legacy payload, which nothing reads once a snapshot exists
  const removeLegacyCipher = !!item.snapshot && !item.cipher
  // Heads describe the snapshot written with them. Stale heads paired with a newer version would let
  // a client skip a snapshot it needs, so a write without heads removes them (docs/sync-design.md).
  const remove = [...(removeLegacyCipher ? ['cipher'] : []), ...(item.heads ? [] : ['heads'])]
  return {
    set: {
      metadata: item.metadata,
      snapshot: item.snapshot || undefined,
      cipher: item.cipher || undefined,
      heads: item.heads || undefined,
      modifiedAt,
    },
    remove,
  }
}

/** Writes an item and bumps its version. With `unlessDeleted`, the write fails its condition on a tombstone. */
function updateItemCommand(
  tables: VaultTableNames,
  item: VaultItem,
  { set, remove }: ItemUpdate,
  { unlessDeleted = false } = {},
): UpdateCommand {
  return new UpdateCommand({
    TableName: tables.items,
    Key: {
      account: item.account,
      item: item.item,
    },
    ...buildUpdateParams({
      set: {
        ...set,
        version: new RawUpdateValue('if_not_exists(#version, :zero) + :one', { ':zero': 0, ':one': 1 }),
      },
      remove,
      // Older rows may mark deletion with a top-level attribute, which the manifest also reads
      condition: unlessDeleted
        ? {
          expression: '(attribute_not_exists(#metadata.#deleted) OR #metadata.#deleted <> :true)'
            + ' AND (attribute_not_exists(#deleted) OR #deleted <> :true)',
          names: { '#deleted': 'deleted' },
          values: { ':true': true },
        }
        : undefined,
    }),
    // The record as it was before this write, which gives both the version the write made and how
    // much it grew the item. Unlike a read, returning it costs no read capacity.
    ReturnValues: 'ALL_OLD',
  })
}

/** The version a write made and how many bytes it added, from the record as it was before */
function writeResult(item: VaultItem, { set, remove }: ItemUpdate, response: UpdateCommandOutput): SetItemResult {
  const before = response.Attributes
  const version = (typeof before?.version === 'number' ? before.version : 0) + 1
  const after: Record<string, unknown> = { account: item.account, item: item.item, ...before, version }
  for (const [name, value] of Object.entries(set)) {
    if (value !== undefined) after[name] = value
  }
  for (const name of remove) {
    delete after[name]
  }
  const sizeBefore = before ? storedItemSize(before) : 0
  return { version, storageDelta: storedItemSize(after) - sizeBefore }
}

/**
 * Counts how many bytes the account's items take up, as `setItem` does, and stores it as the
 * account's usage, with when it was counted. It reads every item in full. A write that lands while it
 * reads may be left out of the count, which is only ever off by that write.
 */
export async function recountStorageUsage({ client, tables }: DynamoContext, { account }: BaseData): Promise<number> {
  let total = 0
  for await (const record of queryAll(client, { TableName: tables.items, ...partitionKeyCondition('account', account) })) {
    total += storedItemSize(record)
  }
  await client.send(new UpdateCommand({
    TableName: tables.accounts,
    Key: { account },
    UpdateExpression: 'SET storageBytes = :total, storageCountedAt = :now',
    ConditionExpression: 'attribute_exists(account)',
    ExpressionAttributeValues: { ':total': total, ':now': Date.now() },
  }))
  return total
}

export async function fetchManifest({ client, tables }: DynamoContext, { account }: BaseData): Promise<ManifestEntry[]> {
  const manifest: ManifestEntry[] = []
  const records = queryAll(client, {
    TableName: tables.items,
    ...partitionKeyCondition('account', account),
    ...projection(['item', 'version', 'modifiedAt', 'metadata.modified', 'metadata.deleted', 'deleted', 'heads']),
  })

  for await (const record of records) {
    const itemId = readItemId(record)
    if (!itemId) continue
    const isDeleted = record.metadata?.deleted === true || record.deleted === true
    const modifiedAt = typeof record.modifiedAt === 'number'
      ? record.modifiedAt
      : (typeof record.metadata?.modified === 'number' ? record.metadata.modified : 0)
    const version = typeof record.version === 'number' ? record.version : 1
    const heads = isDeleted ? undefined : CryptoResultSchema.safeParse(record.heads).data
    manifest.push({
      itemId,
      version,
      modifiedAt,
      ...(isDeleted ? { isDeleted: true } : {}),
      ...(heads ? { heads } : {}),
    })
  }

  return manifest
}

export async function listItemFormats(
  { client, tables }: DynamoContext,
  { account }: BaseData,
): Promise<ItemFormatSummary[]> {
  const formats: ItemFormatSummary[] = []
  const records = queryAll(client, {
    TableName: tables.items,
    ...partitionKeyCondition('account', account),
    ...projection(['item', 'metadata.deleted', 'snapshot.iv', 'snapshot.format', 'snapshot.kver', 'cipher']),
  })

  for await (const record of records) {
    const itemId = readItemId(record)
    if (!itemId) continue
    const snapshotFormat = record.snapshot?.format
    const snapshotKver = record.snapshot?.kver
    formats.push({
      itemId,
      deleted: record.metadata?.deleted === true,
      hasSnapshot: record.snapshot !== undefined,
      ...(typeof snapshotFormat === 'number' ? { snapshotFormat } : {}),
      ...(typeof snapshotKver === 'string' ? { snapshotKver } : {}),
      hasCipher: typeof record.cipher === 'string' && record.cipher.length > 0,
    })
  }

  return formats
}

export async function fetchByIds(
  { client, tables }: DynamoContext,
  { account, itemIds }: BaseData & { itemIds: ItemId[] },
): Promise<FetchedVaultItem[]> {
  // BatchGet rejects duplicate keys
  const uniqueItemIds = Array.from(new Set(itemIds))
  const batches = chunk(uniqueItemIds, FETCH_BATCH_SIZE)

  const batchResults = await Promise.all(
    batches.map(async batch => {
      const items: VaultItem[] = []
      await sendBatchWithRetry<BatchGetCommandInput['RequestItems']>({
        request: {
          [tables.items]: {
            Keys: batch.map(itemId => ({ account, item: itemId })),
            ...ITEM_DATA_PROJECTION,
          },
        },
        commandName: 'BatchGetCommand',
        unprocessedName: 'keys',
        send: async request => {
          const response = await client.send(new BatchGetCommand({ RequestItems: request }))
          items.push(...(response.Responses?.[tables.items] ?? []) as VaultItem[])
          return response.UnprocessedKeys
        },
      })
      return items
    }),
  )

  return batchResults.flat().map(fromStoredItem)
}

/** The item ID of an items-table record, or undefined for a record without one */
function readItemId(record: Record<string, unknown>): ItemId | undefined {
  return typeof record.item === 'string' && record.item !== '' ? record.item as ItemId : undefined
}
