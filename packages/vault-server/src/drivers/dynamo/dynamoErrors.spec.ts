import {
  ConditionalCheckFailedException,
  ResourceInUseException,
} from '@aws-sdk/client-dynamodb'
import {
  isConditionalCheckFailure,
  isResourceInUseError,
} from './dynamoErrors'

describe('dynamoErrors', () => {
  describe('isResourceInUseError', () => {
    it('returns true for ResourceInUseException instances', () => {
      const err = new ResourceInUseException({
        $metadata: { httpStatusCode: 400 },
        message: 'Table already exists: FlockItems',
      })
      expect(isResourceInUseError(err)).toBe(true)
    })

    it('returns true for error-like objects with name, code, or __type', () => {
      expect(isResourceInUseError({ name: 'ResourceInUseException' })).toBe(true)
      expect(isResourceInUseError({ code: 'ResourceInUseException' })).toBe(true)
      expect(isResourceInUseError({
        __type: 'com.amazonaws.dynamodb.v20120810#ResourceInUseException',
      })).toBe(true)
    })

    it('ignores the message, which could match unrelated errors', () => {
      expect(isResourceInUseError(new Error('ResourceInUseException occurred'))).toBe(false)
      expect(isResourceInUseError(new Error('Cannot create table: Table already exists'))).toBe(false)
    })

    it('returns false for unrelated errors or non-object values', () => {
      expect(isResourceInUseError(null)).toBe(false)
      expect(isResourceInUseError(undefined)).toBe(false)
      expect(isResourceInUseError('error string')).toBe(false)
      expect(isResourceInUseError({})).toBe(false)
      expect(isResourceInUseError(new Error('TableNotFoundException'))).toBe(false)
    })
  })

  describe('isConditionalCheckFailure', () => {
    it('returns true for ConditionalCheckFailedException instances', () => {
      const err = new ConditionalCheckFailedException({
        $metadata: { httpStatusCode: 400 },
        message: 'The conditional request failed',
      })
      expect(isConditionalCheckFailure(err)).toBe(true)
    })

    it('returns true for error-like objects with name, code, or __type', () => {
      expect(isConditionalCheckFailure({ name: 'ConditionalCheckFailedException' })).toBe(true)
      expect(isConditionalCheckFailure({ code: 'ConditionalCheckFailedException' })).toBe(true)
      expect(isConditionalCheckFailure({
        __type: 'com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException',
      })).toBe(true)
    })

    it('ignores the message, which could match unrelated errors', () => {
      expect(isConditionalCheckFailure(new Error('The conditional request failed'))).toBe(false)
    })

    it('returns false for unrelated errors or non-object values', () => {
      expect(isConditionalCheckFailure(null)).toBe(false)
      expect(isConditionalCheckFailure(undefined)).toBe(false)
      expect(isConditionalCheckFailure(123)).toBe(false)
      expect(isConditionalCheckFailure({})).toBe(false)
      expect(isConditionalCheckFailure(new Error('ValidationException'))).toBe(false)
    })
  })
})
