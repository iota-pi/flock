import { buildUpdateParams, cursorKeyCondition, projection, RawUpdateValue } from './expressions'

describe('buildUpdateParams', () => {
  it('builds a SET expression and mapped values for the given fields', () => {
    const result = buildUpdateParams({
      set: {
        reminderEnabled: true,
        reminderTime: '08:00',
        iterations: 5000,
      },
    })

    expect(result.UpdateExpression).toBe('SET #reminderEnabled = :reminderEnabled, #reminderTime = :reminderTime, #iterations = :iterations')
    expect(result.ExpressionAttributeNames).toEqual({
      '#reminderEnabled': 'reminderEnabled',
      '#reminderTime': 'reminderTime',
      '#iterations': 'iterations',
    })
    expect(result.ExpressionAttributeValues).toEqual({
      ':reminderEnabled': true,
      ':reminderTime': '08:00',
      ':iterations': 5000,
    })
  })

  it('filters out undefined values while preserving null, false, 0, and empty string', () => {
    const result = buildUpdateParams({
      set: {
        definedString: 'flock',
        emptyString: '',
        nullValue: null,
        falseValue: false,
        zeroValue: 0,
        undefinedValue: undefined,
      },
    })

    expect(result.UpdateExpression).toBe('SET #definedString = :definedString, #emptyString = :emptyString, #nullValue = :nullValue, #falseValue = :falseValue, #zeroValue = :zeroValue')
    expect(result.ExpressionAttributeValues).toEqual({
      ':definedString': 'flock',
      ':emptyString': '',
      ':nullValue': null,
      ':falseValue': false,
      ':zeroValue': 0,
    })
  })

  it('returns an empty expression when there is nothing to set or remove', () => {
    for (const set of [{}, { a: undefined, b: undefined }]) {
      expect(buildUpdateParams({ set })).toEqual({
        UpdateExpression: '',
        ConditionExpression: undefined,
        ExpressionAttributeNames: {},
        ExpressionAttributeValues: {},
      })
    }
  })

  it('declares each attribute once across SET, REMOVE and the condition', () => {
    expect(buildUpdateParams({
      set: {
        metadata: { modified: 1 },
        snapshot: undefined,
        version: new RawUpdateValue('if_not_exists(#version, :zero) + :one', { ':zero': 0, ':one': 1 }),
      },
      remove: ['cipher'],
      condition: { expression: '#deleted <> :true', names: { '#deleted': 'deleted' }, values: { ':true': true } },
    })).toEqual({
      UpdateExpression: 'SET #metadata = :metadata, #version = if_not_exists(#version, :zero) + :one REMOVE #cipher',
      ConditionExpression: '#deleted <> :true',
      ExpressionAttributeNames: {
        '#metadata': 'metadata',
        '#version': 'version',
        '#cipher': 'cipher',
        '#deleted': 'deleted',
      },
      ExpressionAttributeValues: {
        ':metadata': { modified: 1 },
        ':zero': 0,
        ':one': 1,
        ':true': true,
      },
    })
  })

  it('builds a REMOVE-only update', () => {
    expect(buildUpdateParams({ remove: ['a', 'b'] })).toEqual({
      UpdateExpression: 'REMOVE #a, #b',
      ConditionExpression: undefined,
      ExpressionAttributeNames: { '#a': 'a', '#b': 'b' },
      ExpressionAttributeValues: {},
    })
  })
})

describe('cursorKeyCondition', () => {
  it('matches the whole partition without a cursor', () => {
    expect(cursorKeyCondition('syncId', 'acct#item', undefined)).toEqual({
      KeyConditionExpression: 'syncId = :syncId',
      ExpressionAttributeValues: { ':syncId': 'acct#item' },
    })
  })

  it('limits the partition to cursors strictly after the given one', () => {
    expect(cursorKeyCondition('account', 'acct', 0)).toEqual({
      KeyConditionExpression: 'account = :account AND #c > :cursor',
      ExpressionAttributeNames: { '#c': 'cursor' },
      ExpressionAttributeValues: { ':account': 'acct', ':cursor': 0 },
    })
  })
})

describe('projection', () => {
  it('names every segment of each path once', () => {
    expect(projection(['item', 'metadata.modified', 'metadata.deleted', 'deleted'])).toEqual({
      ProjectionExpression: '#item, #metadata.#modified, #metadata.#deleted, #deleted',
      ExpressionAttributeNames: {
        '#item': 'item',
        '#metadata': 'metadata',
        '#modified': 'modified',
        '#deleted': 'deleted',
      },
    })
  })
})
