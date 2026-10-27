import { ConditionalCheckFailedException, ResourceInUseException } from '@aws-sdk/client-dynamodb'

/** The string fields that identify an error, from the SDK or from a plain object, as '' when missing */
function readErrorFields(error: object): { name: string, code: string, typeStr: string, message: string } {
  const typed = error as {
    name?: unknown
    code?: unknown
    __type?: unknown
    message?: unknown
  }
  return {
    name: typeof typed.name === 'string' ? typed.name : '',
    code: typeof typed.code === 'string' ? typed.code : '',
    typeStr: typeof typed.__type === 'string' ? typed.__type : '',
    message: typeof typed.message === 'string' ? typed.message : '',
  }
}

/** Whether the error is the SDK exception `name`, or a plain error that names it or has one of its messages */
function isDynamoError(
  error: unknown,
  exceptionClass: abstract new (...args: never[]) => Error,
  exceptionName: string,
  messageFragments: string[],
): boolean {
  if (error instanceof exceptionClass) {
    return true
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  const { name, code, typeStr, message } = readErrorFields(error)

  return (
    name === exceptionName
    || code === exceptionName
    || typeStr.includes(exceptionName)
    || messageFragments.some(fragment => message.includes(fragment))
  )
}

export function isConditionalCheckFailure(error: unknown): boolean {
  return isDynamoError(error, ConditionalCheckFailedException, 'ConditionalCheckFailedException', [
    'ConditionalCheckFailed',
    'conditional request failed',
  ])
}

export function isResourceInUseError(error: unknown): boolean {
  return isDynamoError(error, ResourceInUseException, 'ResourceInUseException', [
    'ResourceInUseException',
    'already exists',
  ])
}
