import {
  ConditionalCheckFailedException,
  InternalServerError,
  LimitExceededException,
  ProvisionedThroughputExceededException,
  ResourceInUseException,
  ThrottlingException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb'

export const TRANSIENT_DYNAMO_ERROR_NAMES = new Set([
  'ProvisionedThroughputExceededException',
  'InternalServerError',
  'InternalServerErrorException',
  'RequestLimitExceeded',
  'ThrottlingException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'TransactionConflictException',
  'RequestTimeout',
  'RequestTimeoutException',
  'LimitExceededException',
  'NetworkingError',
  'TimeoutError',
  'FetchError',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
])

export const TRANSIENT_HTTP_STATUS_CODES = new Set([429, 500, 502, 503, 504])

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

export function isTransientDynamoError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  if (
    error instanceof ProvisionedThroughputExceededException ||
    error instanceof InternalServerError ||
    error instanceof ThrottlingException ||
    error instanceof LimitExceededException ||
    error instanceof TransactionConflictException
  ) {
    return true
  }

  const typed = error as {
    $retryable?: unknown
    $metadata?: { httpStatusCode?: unknown }
    cause?: unknown
  }

  // AWS SDK v3 $retryable property
  if (typed.$retryable !== undefined) {
    return true
  }

  // HTTP status codes for throttling (429) or transient 5xx server errors
  const statusCode = typed.$metadata?.httpStatusCode
  if (typeof statusCode === 'number' && TRANSIENT_HTTP_STATUS_CODES.has(statusCode)) {
    return true
  }

  const { name, code, typeStr, message } = readErrorFields(error)
  const typeName = typeStr.includes('#') ? typeStr.split('#')[1] : typeStr

  if (
    (name && TRANSIENT_DYNAMO_ERROR_NAMES.has(name)) ||
    (code && TRANSIENT_DYNAMO_ERROR_NAMES.has(code)) ||
    (typeName && TRANSIENT_DYNAMO_ERROR_NAMES.has(typeName))
  ) {
    return true
  }

  if (
    message.includes('ProvisionedThroughputExceededException') ||
    message.includes('Throughput exceeds') ||
    message.includes('throttling') ||
    message.includes('rate exceeded') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('socket hang up')
  ) {
    return true
  }

  if (typed.cause && typed.cause !== error) {
    return isTransientDynamoError(typed.cause)
  }

  return false
}
