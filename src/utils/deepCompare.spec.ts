import { describe, expect, it } from 'vitest'
import { deepEqual } from './deepCompare'

describe('deepEqual', () => {
  it('handles primitive equality', () => {
    expect(deepEqual(1, 1)).toBe(true)
    expect(deepEqual('flock', 'flock')).toBe(true)
    expect(deepEqual(true, false)).toBe(false)
    expect(deepEqual(NaN, NaN)).toBe(true)
  })

  it('handles shallow object equality', () => {
    expect(deepEqual({ id: '1', name: 'A' }, { id: '1', name: 'A' })).toBe(true)
    expect(deepEqual({ id: '1', name: 'A' }, { id: '1', name: 'B' })).toBe(false)
  })

  it('handles deep nested object equality', () => {
    const left = {
      id: 'root',
      nested: {
        level: 2,
        flags: { archived: false },
      },
    }

    const right = {
      id: 'root',
      nested: {
        level: 2,
        flags: { archived: false },
      },
    }

    const different = {
      ...right,
      nested: {
        ...right.nested,
        flags: { archived: true },
      },
    }

    expect(deepEqual(left, right)).toBe(true)
    expect(deepEqual(left, different)).toBe(false)
  })

  it('handles array equality', () => {
    expect(deepEqual([1, 2, { x: 3 }], [1, 2, { x: 3 }])).toBe(true)
    expect(deepEqual([1, 2, 3], [1, 3, 2])).toBe(false)
    expect(deepEqual([1, 2], [1, 2, 3])).toBe(false)
  })

  it('handles Date equality edge cases', () => {
    const sameInstantA = new Date('2025-01-01T00:00:00.000Z')
    const sameInstantB = new Date('2025-01-01T00:00:00.000Z')
    const differentInstant = new Date('2025-01-01T00:00:01.000Z')

    expect(deepEqual(sameInstantA, sameInstantB)).toBe(true)
    expect(deepEqual(sameInstantA, differentInstant)).toBe(false)
    expect(deepEqual(sameInstantA, { value: sameInstantA.getTime() })).toBe(false)
  })
})