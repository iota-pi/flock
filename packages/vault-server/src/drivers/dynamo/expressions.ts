import type { QueryCommandInput, UpdateCommandInput } from '@aws-sdk/lib-dynamodb'

/** A SET value written as its own expression, such as `if_not_exists(...)`, instead of as a value placeholder */
export class RawUpdateValue {
  constructor(
    readonly expression: string,
    readonly values: Record<string, unknown> = {},
  ) {}
}

export interface DynamoUpdateSpec {
  /** Attributes to SET, in order. Undefined ones are left out. */
  set?: Record<string, unknown>
  remove?: string[]
  condition?: {
    expression: string
    names?: Record<string, string>
    values?: Record<string, unknown>
  }
}

type DynamoUpdateParams = Pick<
  UpdateCommandInput,
  'UpdateExpression' | 'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'
>

/**
 * Builds an update's expressions, names and values, declaring each attribute once. Attribute names
 * go through placeholders (`#name`), so app fields may be reserved words. An update with nothing to
 * SET or REMOVE has an empty `UpdateExpression`.
 */
export function buildUpdateParams({ set = {}, remove = [], condition }: DynamoUpdateSpec): DynamoUpdateParams {
  const setEntries = Object.entries(set).filter(([, v]) => v !== undefined)
  const names: Record<string, string> = {}
  const values: Record<string, unknown> = {}

  const assignments = setEntries.map(([name, value]) => {
    names[`#${name}`] = name
    if (value instanceof RawUpdateValue) {
      Object.assign(values, value.values)
      return `#${name} = ${value.expression}`
    }
    values[`:${name}`] = value
    return `#${name} = :${name}`
  })
  for (const name of remove) {
    names[`#${name}`] = name
  }
  Object.assign(names, condition?.names)
  Object.assign(values, condition?.values)

  return {
    UpdateExpression: [
      assignments.length > 0 ? `SET ${assignments.join(', ')}` : undefined,
      remove.length > 0 ? `REMOVE ${remove.map(name => `#${name}`).join(', ')}` : undefined,
    ].filter(Boolean).join(' '),
    ConditionExpression: condition?.expression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }
}

/**
 * The key condition for a partition, optionally limited to cursors strictly after `afterCursor`.
 * Pulls have no lookback (docs/sync-design.md).
 */
export function cursorKeyCondition(
  partitionKey: string,
  partitionValue: unknown,
  afterCursor: number | undefined,
): Pick<QueryCommandInput, 'KeyConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'> {
  const keyCondition = `${partitionKey} = :${partitionKey}`
  if (typeof afterCursor !== 'number') {
    return {
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: { [`:${partitionKey}`]: partitionValue },
    }
  }
  return {
    KeyConditionExpression: `${keyCondition} AND #c > :cursor`,
    ExpressionAttributeNames: { '#c': 'cursor' },
    ExpressionAttributeValues: { [`:${partitionKey}`]: partitionValue, ':cursor': afterCursor },
  }
}
