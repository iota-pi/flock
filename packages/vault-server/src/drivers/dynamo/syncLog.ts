import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import { backOff, SYNC_LOG_TTL_DAYS, type BackoffOptions, type SyncLogEntry, type SyncLogMessage } from '@vault/shared'
import type { AppendLogInput, BaseData, LogPushResult, ReadLogInput, SyncLogPage } from '../vaultDriver'
import type { DynamoContext } from './commands'
import { isRetryableTransactionCancel } from './dynamoErrors'

export const SYNC_LOG_PAGE_SIZE = 200

/** The seq of the row holding the last seq used. Rows of the log start at 1. */
const HEAD_SEQ = 0
const SYNC_LOG_TTL_SECONDS = SYNC_LOG_TTL_DAYS * 24 * 60 * 60

// A transaction holds at most 100 actions and 4 MB, and one action is the head row's update
const MAX_ROWS_PER_TRANSACTION = 99
const MAX_BYTES_PER_TRANSACTION = 3.5 * 1024 * 1024

export const MAX_APPEND_ATTEMPTS = 8
const APPEND_BACKOFF: BackoffOptions = { baseMs: 25, maxMs: 1000, jitterMs: 50 }

/** Splits messages, in order, into groups that each fit in one transaction */
function groupForTransactions(messages: SyncLogMessage[]): SyncLogMessage[][] {
  const groups: SyncLogMessage[][] = []
  let group: SyncLogMessage[] = []
  let groupBytes = 0
  for (const message of messages) {
    const bytes = Buffer.byteLength(JSON.stringify(message))
    const isFull = group.length === MAX_ROWS_PER_TRANSACTION || groupBytes + bytes > MAX_BYTES_PER_TRANSACTION
    if (group.length > 0 && isFull) {
      groups.push(group)
      group = []
      groupBytes = 0
    }
    group.push(message)
    groupBytes += bytes
  }
  if (group.length > 0) {
    groups.push(group)
  }
  return groups
}

/**
 * Writes `messages` at the seqs after `expectedHead`. It commits only while the head is still
 * `expectedHead`, so transactions commit in seq order and never leave a seq unused.
 */
function buildAppendCommand(
  { tables }: DynamoContext,
  account: string,
  messages: SyncLogMessage[],
  expectedHead: number,
): TransactWriteCommand {
  const createdAt = Date.now()
  const expiresAt = Math.floor(createdAt / 1000) + SYNC_LOG_TTL_SECONDS
  return new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tables.syncLog,
          Key: { account, seq: HEAD_SEQ },
          UpdateExpression: 'SET #head = :next',
          ConditionExpression: expectedHead === 0 ? 'attribute_not_exists(#head)' : '#head = :expected',
          ExpressionAttributeNames: { '#head': 'head' },
          ExpressionAttributeValues: {
            ':next': expectedHead + messages.length,
            ...(expectedHead === 0 ? {} : { ':expected': expectedHead }),
          },
        },
      },
      ...messages.map(({ itemId, encryptedMessage }, index) => ({
        Put: {
          TableName: tables.syncLog,
          Item: { account, seq: expectedHead + index + 1, itemId, encryptedMessage, createdAt, expiresAt },
          ConditionExpression: 'attribute_not_exists(#seq)',
          ExpressionAttributeNames: { '#seq': 'seq' },
        },
      })),
    ],
  })
}

/** Appends one transaction's worth of messages and returns the head it started from */
async function appendTransaction(
  context: DynamoContext,
  account: string,
  messages: SyncLogMessage[],
): Promise<number> {
  for (let attempt = 0; ; attempt += 1) {
    const expectedHead = await readLogHead(context, { account })
    try {
      await context.client.send(buildAppendCommand(context, account, messages, expectedHead))
      return expectedHead
    } catch (error) {
      if (!isRetryableTransactionCancel(error) || attempt + 1 >= MAX_APPEND_ATTEMPTS) {
        throw error
      }
      await backOff(attempt, APPEND_BACKOFF)
    }
  }
}

export async function appendLog(context: DynamoContext, input: AppendLogInput): Promise<LogPushResult[]> {
  const results: LogPushResult[] = []
  // One at a time, so that the groups' rows stay in order
  for (const group of groupForTransactions(input.messages)) {
    const startHead = await appendTransaction(context, input.account, group)
    results.push(...group.map(({ itemId }, index) => ({ itemId, seq: startHead + index + 1 })))
  }
  return results
}

export async function readLog(
  { client, tables, syncLogPageSize }: DynamoContext,
  input: ReadLogInput,
): Promise<SyncLogPage> {
  const response = await client.send(new QueryCommand({
    TableName: tables.syncLog,
    KeyConditionExpression: 'account = :account AND #seq > :after',
    ExpressionAttributeNames: { '#seq': 'seq' },
    ExpressionAttributeValues: { ':account': input.account, ':after': input.after },
    ConsistentRead: true,
    Limit: syncLogPageSize,
  }))
  const rows = (response.Items ?? []) as SyncLogEntry[]
  return {
    entries: rows.map(({ seq, itemId, encryptedMessage, createdAt }) => ({ seq, itemId, encryptedMessage, createdAt })),
    hasMore: !!response.LastEvaluatedKey,
  }
}

export async function readLogHead({ client, tables }: DynamoContext, { account }: BaseData): Promise<number> {
  const response = await client.send(new GetCommand({
    TableName: tables.syncLog,
    Key: { account, seq: HEAD_SEQ },
    ConsistentRead: true,
  }))
  return (response.Item?.head as number | undefined) ?? 0
}
