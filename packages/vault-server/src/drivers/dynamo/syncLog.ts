import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb'
import {
  backOff,
  MAX_LOG_PUSH_BYTES,
  MAX_LOG_PUSH_ROWS,
  SYNC_LOG_TTL_DAYS,
  type BackoffOptions,
  type SyncLogEntry,
  type SyncLogMessage,
} from '@vault/shared'
import type { AppendLogInput, BaseData, LogPushResult, ReadLogInput, SyncLogPage } from '../vaultDriver'
import type { DynamoContext } from './commands'
import { isRetryableTransactionCancel } from './dynamoErrors'
import { PushTooLargeError, QuotaExceededError } from '../../errors'

export const SYNC_LOG_PAGE_SIZE = 200

/** The seq of the row holding the last seq used. Rows of the log start at 1. */
const HEAD_SEQ = 0
const SYNC_LOG_TTL_SECONDS = SYNC_LOG_TTL_DAYS * 24 * 60 * 60

export const MAX_APPEND_ATTEMPTS = 8
const APPEND_BACKOFF: BackoffOptions = { baseMs: 25, maxMs: 1000, jitterMs: 50 }

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The head row: the last seq used, and how many bytes of messages were appended on `usageDay` (days
 * since the epoch, UTC). Every append rewrites both under its condition on the head, so the count
 * can't miss a concurrent append.
 */
interface LogHead {
  head: number
  usageDay?: number
  usageBytes?: number
}

/** The day's usage once `bytes` more are appended, throwing if that passes `maxBytesPerDay` */
function nextUsage(head: LogHead, bytes: number, now: number, maxBytesPerDay: number | undefined) {
  const day = Math.floor(now / DAY_MS)
  const usedToday = head.usageDay === day ? (head.usageBytes ?? 0) : 0
  const usageBytes = usedToday + bytes
  if (maxBytesPerDay !== undefined && usageBytes > maxBytesPerDay) {
    throw new QuotaExceededError(`Appending ${bytes} bytes would pass the log quota of ${maxBytesPerDay} a day`)
  }
  return { usageDay: day, usageBytes }
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
  usage: { usageDay: number, usageBytes: number },
  createdAt: number,
): TransactWriteCommand {
  const expiresAt = Math.floor(createdAt / 1000) + SYNC_LOG_TTL_SECONDS
  return new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tables.syncLog,
          Key: { account, seq: HEAD_SEQ },
          UpdateExpression: 'SET #head = :next, #usageDay = :usageDay, #usageBytes = :usageBytes',
          ConditionExpression: expectedHead === 0 ? 'attribute_not_exists(#head)' : '#head = :expected',
          ExpressionAttributeNames: { '#head': 'head', '#usageDay': 'usageDay', '#usageBytes': 'usageBytes' },
          ExpressionAttributeValues: {
            ':next': expectedHead + messages.length,
            ':usageDay': usage.usageDay,
            ':usageBytes': usage.usageBytes,
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

/**
 * Appends a push in one transaction, so it commits whole or not at all. A push over
 * `MAX_LOG_PUSH_ROWS` or `MAX_LOG_PUSH_BYTES` throws `PushTooLargeError` and appends nothing.
 */
export async function appendLog(context: DynamoContext, input: AppendLogInput): Promise<LogPushResult[]> {
  const { account, messages, maxBytesPerDay } = input
  const bytes = messages.reduce((total, message) => total + Buffer.byteLength(JSON.stringify(message)), 0)
  if (messages.length > MAX_LOG_PUSH_ROWS || bytes > MAX_LOG_PUSH_BYTES) {
    throw new PushTooLargeError(`A push of ${messages.length} rows and ${bytes} bytes is more than one transaction`)
  }

  for (let attempt = 0; ; attempt += 1) {
    const head = await readHeadRow(context, { account })
    const expectedHead = head.head
    const createdAt = Date.now()
    const usage = nextUsage(head, bytes, createdAt, maxBytesPerDay)
    try {
      await context.client.send(buildAppendCommand(context, account, messages, expectedHead, usage, createdAt))
      return messages.map(({ itemId }, index) => ({ itemId, seq: expectedHead + index + 1 }))
    } catch (error) {
      if (!isRetryableTransactionCancel(error) || attempt + 1 >= MAX_APPEND_ATTEMPTS) {
        throw error
      }
      await backOff(attempt, APPEND_BACKOFF)
    }
  }
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

async function readHeadRow({ client, tables }: DynamoContext, { account }: BaseData): Promise<LogHead> {
  const response = await client.send(new GetCommand({
    TableName: tables.syncLog,
    Key: { account, seq: HEAD_SEQ },
    ConsistentRead: true,
  }))
  const item = response.Item
  return {
    head: (item?.head as number | undefined) ?? 0,
    usageDay: item?.usageDay as number | undefined,
    usageBytes: item?.usageBytes as number | undefined,
  }
}
