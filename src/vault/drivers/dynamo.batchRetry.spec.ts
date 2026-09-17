import {
  ConditionalCheckFailedException,
  InternalServerError,
  LimitExceededException,
  ProvisionedThroughputExceededException,
  ThrottlingException,
  TransactionConflictException,
} from '@aws-sdk/client-dynamodb'
import DynamoDriver, { isTransientDynamoError } from './dynamo'

describe('isTransientDynamoError', () => {
  it('identifies transient AWS SDK error instances', () => {
    expect(isTransientDynamoError(new ProvisionedThroughputExceededException({
      $metadata: { httpStatusCode: 400 },
      message: 'Throughput exceeded',
    }))).toBe(true)

    expect(isTransientDynamoError(new InternalServerError({
      $metadata: { httpStatusCode: 500 },
      message: 'Internal server error',
    }))).toBe(true)

    expect(isTransientDynamoError(new ThrottlingException({
      $metadata: { httpStatusCode: 400 },
      message: 'Throttled',
    }))).toBe(true)

    expect(isTransientDynamoError(new LimitExceededException({
      $metadata: { httpStatusCode: 400 },
      message: 'Limit exceeded',
    }))).toBe(true)

    expect(isTransientDynamoError(new TransactionConflictException({
      $metadata: { httpStatusCode: 400 },
      message: 'Transaction conflict',
    }))).toBe(true)
  })

  it('identifies AWS SDK v3 retryable marker and HTTP status codes', () => {
    expect(isTransientDynamoError({ $retryable: {} })).toBe(true)
    expect(isTransientDynamoError({ $retryable: { throttling: true } })).toBe(true)

    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 429 } })).toBe(true)
    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 500 } })).toBe(true)
    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 502 } })).toBe(true)
    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 503 } })).toBe(true)
    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 504 } })).toBe(true)

    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 400 } })).toBe(false)
    expect(isTransientDynamoError({ $metadata: { httpStatusCode: 404 } })).toBe(false)
  })

  it('identifies transient error names, codes, and wire format __type', () => {
    expect(isTransientDynamoError({ name: 'ProvisionedThroughputExceededException' })).toBe(true)
    expect(isTransientDynamoError({ name: 'RequestLimitExceeded' })).toBe(true)
    expect(isTransientDynamoError({ name: 'ServiceUnavailable' })).toBe(true)
    expect(isTransientDynamoError({ name: 'TimeoutError' })).toBe(true)
    expect(isTransientDynamoError({ code: 'ECONNRESET' })).toBe(true)
    expect(isTransientDynamoError({ code: 'ETIMEDOUT' })).toBe(true)

    expect(isTransientDynamoError({ __type: 'com.amazonaws.dynamodb.v20120810#ProvisionedThroughputExceededException' })).toBe(true)
    expect(isTransientDynamoError({ __type: 'com.amazonaws.dynamodb.v20120810#InternalServerError' })).toBe(true)
  })

  it('identifies transient errors by message substrings and nested cause', () => {
    expect(isTransientDynamoError(new Error('Rate exceeded (throttling)'))).toBe(true)
    expect(isTransientDynamoError(new Error('read ECONNRESET'))).toBe(true)
    expect(isTransientDynamoError(new Error('socket hang up'))).toBe(true)

    const wrappedError = new Error('Wrapper failed', {
      cause: new ProvisionedThroughputExceededException({
        $metadata: { httpStatusCode: 400 },
        message: 'Underlying throughput exceeded',
      }),
    })
    expect(isTransientDynamoError(wrappedError)).toBe(true)
  })

  it('rejects non-transient errors', () => {
    expect(isTransientDynamoError(null)).toBe(false)
    expect(isTransientDynamoError(undefined)).toBe(false)
    expect(isTransientDynamoError({})).toBe(false)
    expect(isTransientDynamoError(new Error('Syntax error'))).toBe(false)

    expect(isTransientDynamoError(new ConditionalCheckFailedException({
      $metadata: { httpStatusCode: 400 },
      message: 'The conditional request failed',
    }))).toBe(false)

    expect(isTransientDynamoError({
      name: 'ValidationException',
      $metadata: { httpStatusCode: 400 },
      message: 'One or more parameter values were invalid',
    })).toBe(false)

    expect(isTransientDynamoError({
      name: 'ResourceNotFoundException',
      $metadata: { httpStatusCode: 400 },
      message: 'Cannot do operations on a non-existent table',
    })).toBe(false)

    // Ensure ItemCollectionSizeLimitExceededException does not match LimitExceededException
    expect(isTransientDynamoError({
      name: 'ItemCollectionSizeLimitExceededException',
      $metadata: { httpStatusCode: 400 },
      message: 'Collection size exceeded',
    })).toBe(false)
  })
})

describe('Batch operations retry on transient errors', () => {
  let driver: DynamoDriver
  let mockSend: ReturnType<typeof vi.fn>

  beforeEach(() => {
    driver = new DynamoDriver()
    mockSend = vi.fn()
    ;(driver as any).internalClient = { send: mockSend }
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('executeBatchGetWithRetry', () => {
    it('retries when client.send throws ProvisionedThroughputExceededException and succeeds', async () => {
      const throughputError = new ProvisionedThroughputExceededException({
        $metadata: { httpStatusCode: 400 },
        message: 'Provisioned throughput exceeded',
      })

      const successResponse = {
        Responses: {
          FlockItems: [{ account: 'acc1', item: 'item1' }],
        },
        UnprocessedKeys: {},
      }

      mockSend
        .mockRejectedValueOnce(throughputError)
        .mockResolvedValueOnce(successResponse)

      const promise = (driver as any).executeBatchGetWithRetry({
        FlockItems: { Keys: [{ account: 'acc1', item: 'item1' }] },
      }, 3)

      await vi.runAllTimersAsync()
      const result = await promise

      expect(mockSend).toHaveBeenCalledTimes(2)
      expect(result).toEqual({
        FlockItems: [{ account: 'acc1', item: 'item1' }],
      })
    })

    it('accumulates partial responses when a retry occurs after partial success', async () => {
      const partialResponse1 = {
        Responses: {
          FlockItems: [{ account: 'acc1', item: 'item1' }],
        },
        UnprocessedKeys: {
          FlockItems: { Keys: [{ account: 'acc1', item: 'item2' }] },
        },
      }

      const transientError = new InternalServerError({
        $metadata: { httpStatusCode: 500 },
        message: 'Internal server error',
      })

      const partialResponse2 = {
        Responses: {
          FlockItems: [{ account: 'acc1', item: 'item2' }],
        },
        UnprocessedKeys: {},
      }

      mockSend
        .mockResolvedValueOnce(partialResponse1)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValueOnce(partialResponse2)

      const promise = (driver as any).executeBatchGetWithRetry({
        FlockItems: { Keys: [{ account: 'acc1', item: 'item1' }, { account: 'acc1', item: 'item2' }] },
      }, 3)

      await vi.runAllTimersAsync()
      const result = await promise

      expect(mockSend).toHaveBeenCalledTimes(3)
      expect(result).toEqual({
        FlockItems: [
          { account: 'acc1', item: 'item1' },
          { account: 'acc1', item: 'item2' },
        ],
      })
    })

    it('throws when transient errors exceed maxRetries', async () => {
      const throughputError = new ProvisionedThroughputExceededException({
        $metadata: { httpStatusCode: 400 },
        message: 'Provisioned throughput exceeded',
      })

      mockSend.mockRejectedValue(throughputError)

      const promise = (driver as any).executeBatchGetWithRetry({
        FlockItems: { Keys: [{ account: 'acc1', item: 'item1' }] },
      }, 2)

      promise.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(promise).rejects.toThrow('Provisioned throughput exceeded')

      // Initial attempt (1) + 2 retries = 3 calls
      expect(mockSend).toHaveBeenCalledTimes(3)
    })

    it('throws immediately on non-transient error without retry', async () => {
      const nonTransientError = new Error('ValidationException: Validation failed')
      nonTransientError.name = 'ValidationException'
      ;(nonTransientError as any).$metadata = { httpStatusCode: 400 }

      mockSend.mockRejectedValueOnce(nonTransientError)

      const promise = (driver as any).executeBatchGetWithRetry({
        FlockItems: { Keys: [{ account: 'acc1', item: 'item1' }] },
      }, 3)

      await expect(promise).rejects.toThrow('Validation failed')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })
  })

  describe('executeBatchWriteWithRetry', () => {
    it('retries when client.send throws InternalServerError and succeeds', async () => {
      const internalError = new InternalServerError({
        $metadata: { httpStatusCode: 500 },
        message: 'Internal server error',
      })

      const successResponse = {
        UnprocessedItems: {},
      }

      mockSend
        .mockRejectedValueOnce(internalError)
        .mockResolvedValueOnce(successResponse)

      const promise = (driver as any).executeBatchWriteWithRetry({
        FlockSyncMessages: [{ PutRequest: { Item: { syncId: 's1' } } }],
      }, 3)

      await vi.runAllTimersAsync()
      await promise

      expect(mockSend).toHaveBeenCalledTimes(2)
    })

    it('throws when transient errors exceed maxRetries in executeBatchWriteWithRetry', async () => {
      const throughputError = new ProvisionedThroughputExceededException({
        $metadata: { httpStatusCode: 400 },
        message: 'Throughput exceeded',
      })

      mockSend.mockRejectedValue(throughputError)

      const promise = (driver as any).executeBatchWriteWithRetry({
        FlockSyncMessages: [{ PutRequest: { Item: { syncId: 's1' } } }],
      }, 2)

      promise.catch(() => {})
      await vi.runAllTimersAsync()
      await expect(promise).rejects.toThrow('Throughput exceeded')

      // 1 initial + 2 retries = 3 calls
      expect(mockSend).toHaveBeenCalledTimes(3)
    })

    it('throws immediately on non-transient error in executeBatchWriteWithRetry without retry', async () => {
      const nonTransientError = new Error('ResourceNotFoundException: Table not found')
      nonTransientError.name = 'ResourceNotFoundException'
      ;(nonTransientError as any).$metadata = { httpStatusCode: 400 }

      mockSend.mockRejectedValueOnce(nonTransientError)

      const promise = (driver as any).executeBatchWriteWithRetry({
        FlockSyncMessages: [{ PutRequest: { Item: { syncId: 's1' } } }],
      }, 3)

      await expect(promise).rejects.toThrow('Table not found')
      expect(mockSend).toHaveBeenCalledTimes(1)
    })
  })
})
