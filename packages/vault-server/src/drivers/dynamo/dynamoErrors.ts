import { ConditionalCheckFailedException, ResourceInUseException } from '@aws-sdk/client-dynamodb'

/** The string fields that identify an error, from the SDK or from a plain object, as '' when missing */
function readErrorFields(error: object): { name: string, code: string, typeStr: string } {
  const typed = error as {
    name?: unknown
    code?: unknown
    __type?: unknown
  }
  return {
    name: typeof typed.name === 'string' ? typed.name : '',
    code: typeof typed.code === 'string' ? typed.code : '',
    typeStr: typeof typed.__type === 'string' ? typed.__type : '',
  }
}

/**
 * Whether the error is the SDK exception, or an error that names it (as one from another copy of
 * the SDK does, where `instanceof` fails)
 */
function isDynamoError(
  error: unknown,
  exceptionClass: abstract new (...args: never[]) => Error,
  exceptionName: string,
): boolean {
  if (error instanceof exceptionClass) {
    return true
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  const { name, code, typeStr } = readErrorFields(error)
  return name === exceptionName || code === exceptionName || typeStr.includes(exceptionName)
}

export function isConditionalCheckFailure(error: unknown): boolean {
  return isDynamoError(error, ConditionalCheckFailedException, 'ConditionalCheckFailedException')
}

export function isResourceInUseError(error: unknown): boolean {
  return isDynamoError(error, ResourceInUseException, 'ResourceInUseException')
}
