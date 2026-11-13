import { createHash } from 'crypto'
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import {
  FAILED_LOGIN_WINDOW_MS,
  isLoginLocked,
  MAX_FAILED_LOGINS,
  type FailedLoginRecord,
  type LoginAttemptReservation,
} from '../../loginThrottle'
import type { BaseData } from '../vaultDriver'
import { sendConditional, type DynamoContext } from './commands'

/**
 * Each round counts against the current window or starts a new one. Only a concurrent attempt
 * starting the window between the two makes a round fail without the ID being locked, and the next
 * round then counts against that window.
 */
const MAX_RESERVE_ROUNDS = 3

/**
 * The throttle row's key for an account ID. Hashing bounds its length (login doesn't limit the ID's)
 * and keeps the IDs people try out of the table.
 */
export function loginThrottleKey(account: string): string {
  return createHash('sha256').update(account).digest('base64url')
}

async function getLoginThrottle({ client, tables }: DynamoContext, account: string): Promise<FailedLoginRecord> {
  const response = await client.send(new GetCommand({
    TableName: tables.loginThrottle,
    Key: { key: loginThrottleKey(account) },
    ConsistentRead: true,
  }))
  const item = response?.Item as FailedLoginRecord | undefined
  return { failedLogins: item?.failedLogins, failedLoginsSince: item?.failedLoginsSince }
}

/**
 * Counts a login attempt against an account ID before its password is checked, whether or not the
 * account exists, so that unknown IDs lock exactly as real ones do. The count and the lock check are
 * one conditional write, so concurrent attempts can't all pass the check before any is counted.
 * Returns the window it was counted in, or undefined when the ID is locked and nothing was counted.
 * Rows expire (by TTL) once their window has ended.
 */
export async function reserveLoginAttempt(
  context: DynamoContext,
  { account }: BaseData,
): Promise<LoginAttemptReservation | undefined> {
  const { client, tables } = context
  const key = { key: loginThrottleKey(account) }
  for (let round = 0; round < MAX_RESERVE_ROUNDS; round += 1) {
    const now = Date.now()
    const windowStart = now - FAILED_LOGIN_WINDOW_MS
    // Count within the current window, unless it has used up its attempts
    const counted = await sendConditional(client, new UpdateCommand({
      TableName: tables.loginThrottle,
      Key: key,
      UpdateExpression: 'ADD failedLogins :one',
      ConditionExpression: 'failedLoginsSince > :windowStart AND failedLogins < :max',
      ExpressionAttributeValues: { ':one': 1, ':windowStart': windowStart, ':max': MAX_FAILED_LOGINS },
      ReturnValues: 'ALL_NEW',
    }))
    const since = (counted?.Attributes as FailedLoginRecord | undefined)?.failedLoginsSince
    if (since !== undefined) {
      return { since }
    }

    // Or start a new window, if there's none or it has ended
    const started = await sendConditional(client, new UpdateCommand({
      TableName: tables.loginThrottle,
      Key: key,
      UpdateExpression: 'SET failedLogins = :one, failedLoginsSince = :now, expiresAt = :expiresAt',
      ConditionExpression: 'attribute_not_exists(failedLoginsSince) OR failedLoginsSince <= :windowStart',
      ExpressionAttributeValues: {
        ':one': 1,
        ':windowStart': windowStart,
        ':now': now,
        // DynamoDB TTLs are in seconds. Deleting the row late is harmless: the window has ended anyway.
        ':expiresAt': Math.ceil((now + FAILED_LOGIN_WINDOW_MS) / 1000),
      },
    }))
    if (started) {
      return { since: now }
    }

    // Neither condition held, so either the window is used up or a concurrent attempt started it
    if (isLoginLocked(await getLoginThrottle(context, account), Date.now())) {
      return undefined
    }
  }
  // Only a stream of attempts on this ID gets here, so refuse rather than leave this one uncounted
  return undefined
}

/**
 * Uncounts an attempt `reserveLoginAttempt` counted, once its password turned out right. Does nothing
 * if its window has since ended, so as not to uncount an attempt in the next one.
 */
export async function releaseLoginAttempt(
  { client, tables }: DynamoContext,
  { account, since }: BaseData & LoginAttemptReservation,
): Promise<void> {
  await sendConditional(client, new UpdateCommand({
    TableName: tables.loginThrottle,
    Key: { key: loginThrottleKey(account) },
    UpdateExpression: 'ADD failedLogins :minusOne',
    ConditionExpression: 'failedLoginsSince = :since AND failedLogins > :zero',
    ExpressionAttributeValues: { ':minusOne': -1, ':since': since, ':zero': 0 },
  }))
}
