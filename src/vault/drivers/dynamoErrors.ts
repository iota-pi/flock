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

export function isConditionalCheckFailure(error: unknown): boolean {
  if (error instanceof ConditionalCheckFailedException) {
    return true
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  const typed = error as {
    name?: unknown
    code?: unknown
    __type?: unknown
    message?: unknown
  }

  const name = typeof typed.name === 'string' ? typed.name : ''
  const code = typeof typed.code === 'string' ? typed.code : ''
  const typeStr = typeof typed.__type === 'string' ? typed.__type : ''
  const message = typeof typed.message === 'string' ? typed.message : ''

  return (
    name === 'ConditionalCheckFailedException'
    || code === 'ConditionalCheckFailedException'
    || typeStr.includes('ConditionalCheckFailedException')
    || message.includes('ConditionalCheckFailed')
    || message.includes('conditional request failed')
  )
}

export function isResourceInUseError(error: unknown): boolean {
  if (error instanceof ResourceInUseException) {
    return true
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  const typed = error as {
    name?: unknown
    code?: unknown
    __type?: unknown
    message?: unknown
  }

  const name = typeof typed.name === 'string' ? typed.name : ''
  const code = typeof typed.code === 'string' ? typed.code : ''
  const typeStr = typeof typed.__type === 'string' ? typed.__type : ''
  const message = typeof typed.message === 'string' ? typed.message : ''

  return (
    name === 'ResourceInUseException'
    || code === 'ResourceInUseException'
    || typeStr.includes('ResourceInUseException')
    || message.includes('ResourceInUseException')
    || message.includes('already exists')
  )
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
    name?: unknown
    code?: unknown
    __type?: unknown
    $retryable?: unknown
    $metadata?: { httpStatusCode?: unknown }
    message?: unknown
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

  const name = typeof typed.name === 'string' ? typed.name : ''
  const code = typeof typed.code === 'string' ? typed.code : ''
  const typeStr = typeof typed.__type === 'string' ? typed.__type : ''
  const typeName = typeStr.includes('#') ? typeStr.split('#')[1] : typeStr

  if (
    (name && TRANSIENT_DYNAMO_ERROR_NAMES.has(name)) ||
    (code && TRANSIENT_DYNAMO_ERROR_NAMES.has(code)) ||
    (typeName && TRANSIENT_DYNAMO_ERROR_NAMES.has(typeName))
  ) {
    return true
  }

  const message = typeof typed.message === 'string' ? typed.message : ''
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
