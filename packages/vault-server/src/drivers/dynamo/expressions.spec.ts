import { buildDynamoUpdate } from './expressions'

describe('buildDynamoUpdate', () => {
  it('builds SET expression and mapped values for provided fields', () => {
    const result = buildDynamoUpdate({
      reminderEnabled: true,
      reminderTime: '08:00',
      iterations: 5000,
    })

    expect(result.expression).toBe('SET #reminderEnabled = :reminderEnabled, #reminderTime = :reminderTime, #iterations = :iterations')
    expect(result.names).toEqual({
      '#reminderEnabled': 'reminderEnabled',
      '#reminderTime': 'reminderTime',
      '#iterations': 'iterations',
    })
    expect(result.values).toEqual({
      ':reminderEnabled': true,
      ':reminderTime': '08:00',
      ':iterations': 5000,
    })
  })

  it('filters out undefined values while preserving null, false, 0, and empty string', () => {
    const result = buildDynamoUpdate({
      definedString: 'flock',
      emptyString: '',
      nullValue: null,
      falseValue: false,
      zeroValue: 0,
      undefinedValue: undefined,
    })

    expect(result.expression).toBe('SET #definedString = :definedString, #emptyString = :emptyString, #nullValue = :nullValue, #falseValue = :falseValue, #zeroValue = :zeroValue')
    expect(result.values).toEqual({
      ':definedString': 'flock',
      ':emptyString': '',
      ':nullValue': null,
      ':falseValue': false,
      ':zeroValue': 0,
    })
  })

  it('returns empty expression and empty values when given an empty object or all-undefined fields', () => {
    expect(buildDynamoUpdate({})).toEqual({
      expression: '',
      names: {},
      values: {},
    })

    expect(buildDynamoUpdate({ a: undefined, b: undefined })).toEqual({
      expression: '',
      names: {},
      values: {},
    })
  })
})

