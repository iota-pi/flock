import { describe, it, expect } from 'vitest'
import { threeWayMerge } from './merge'

describe('threeWayMerge', () => {
  it('keeps base if no changes', () => {
    const base = { a: 1 }
    expect(threeWayMerge(base, base, base)).toEqual(base)
  })

  it('accepts yours if theirs is same as base', () => {
    const base = { a: 1 }
    const theirs = { a: 1 }
    const yours = { a: 2 }
    expect(threeWayMerge(base, theirs, yours)).toEqual({ a: 2 })
  })

  it('accepts theirs if yours is same as base', () => {
    const base = { a: 1 }
    const theirs = { a: 2 }
    const yours = { a: 1 }
    expect(threeWayMerge(base, theirs, yours)).toEqual({ a: 2 })
  })

  it('prioritizes yours on conflict', () => {
    const base = { a: 1 }
    const theirs = { a: 2 } // Remote changed
    const yours = { a: 3 }  // Local changed
    expect(threeWayMerge(base, theirs, yours)).toEqual({ a: 3 })
  })

  it('merges non-conflicting changes', () => {
    const base = { a: 1, b: 1 }
    const theirs = { a: 1, b: 2 } // They changed B
    const yours = { a: 2, b: 1 }  // We changed A
    expect(threeWayMerge(base, theirs, yours)).toEqual({ a: 2, b: 2 })
  })

  it('handles deep objects (yours wins conflict)', () => {
    const base = { val: { x: 1 } }
    const theirs = { val: { x: 2 } }
    const yours = { val: { x: 3 } }
    expect(threeWayMerge(base, theirs, yours)).toEqual({ val: { x: 3 } })
  })
})
