import { createHash } from 'crypto'
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { FAILED_LOGIN_WINDOW_MS, type FailedLoginRecord } from '../../loginThrottle'
import type { BaseData } from '../vaultDriver'
import { sendConditional, type DynamoContext } from './commands'

/**
 * The throttle row's key for an account ID. Hashing bounds its length (login doesn't limit the ID's)
 * and keeps the IDs people try out of the table.
 */
export function loginThrottleKey(account: string): string {
  return createHash('sha256').update(account).digest('base64url')
}

export async function getLoginThrottle({ client, tables }: DynamoContext, { account }: BaseData): Promise<FailedLoginRecord> {
  const response = await client.send(new GetCommand({
    TableName: tables.loginThrottle,
    Key: { key: loginThrottleKey(account) },
    ConsistentRead: true,
  }))
  const item = response?.Item as FailedLoginRecord | undefined
  return { failedLogins: item?.failedLogins, failedLoginsSince: item?.failedLoginsSince }
}

/**
 * Counts a failed login against an account ID, whether or not the account exists, so that unknown
 * IDs lock exactly as real ones do. Rows expire (by TTL) once their window has ended.
 */
export async function recordFailedLogin({ client, tables }: DynamoContext, { account }: BaseData): Promise<void> {
  const key = { key: loginThrottleKey(account) }
  const now = Date.now()
  const values = { ':one': 1, ':windowStart': now - FAILED_LOGIN_WINDOW_MS }
  // Count within the current window
  const counted = await sendConditional(client, new UpdateCommand({
    TableName: tables.loginThrottle,
    Key: key,
    UpdateExpression: 'ADD failedLogins :one',
    ConditionExpression: 'failedLoginsSince > :windowStart',
    ExpressionAttributeValues: values,
  }))
  if (counted) {
    return
  }
  // Or start a new window. If a concurrent failure started it first, this one goes uncounted.
  await sendConditional(client, new UpdateCommand({
    TableName: tables.loginThrottle,
    Key: key,
    UpdateExpression: 'SET failedLogins = :one, failedLoginsSince = :now, expiresAt = :expiresAt',
    ConditionExpression: 'attribute_not_exists(failedLoginsSince) OR failedLoginsSince <= :windowStart',
    ExpressionAttributeValues: {
      ...values,
      ':now': now,
      // DynamoDB TTLs are in seconds. Deleting the row late is harmless: the window has ended anyway.
      ':expiresAt': Math.ceil((now + FAILED_LOGIN_WINDOW_MS) / 1000),
    },
  }))
}
