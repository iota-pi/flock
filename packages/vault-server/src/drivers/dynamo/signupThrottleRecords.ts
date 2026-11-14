import { UpdateCommand } from '@aws-sdk/lib-dynamodb'
import { MAX_SIGNUPS_PER_WINDOW, type SignupReservation } from '../../signupThrottle'
import { sendConditional, type DynamoContext } from './commands'

/**
 * Counts a sign-up against its network's row for the window, unless the window has used up its
 * sign-ups, with one conditional write. Each window has its own row (see `signupReservation`), so
 * there's no window to start or end here. Returns false when the limit is reached and nothing was
 * counted. Rows expire (by TTL) once their window has ended.
 */
export async function reserveSignup(
  { client, tables }: DynamoContext,
  { key, windowEnd }: SignupReservation,
): Promise<boolean> {
  const counted = await sendConditional(client, new UpdateCommand({
    TableName: tables.loginThrottle,
    Key: { key },
    UpdateExpression: 'ADD signups :one SET expiresAt = :expiresAt',
    ConditionExpression: 'attribute_not_exists(signups) OR signups < :max',
    ExpressionAttributeValues: {
      ':one': 1,
      ':max': MAX_SIGNUPS_PER_WINDOW,
      // DynamoDB TTLs are in seconds. Deleting the row late is harmless: the next window has its own.
      ':expiresAt': Math.ceil(windowEnd / 1000),
    },
  }))
  return counted !== undefined
}
