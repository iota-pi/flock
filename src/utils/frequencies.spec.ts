import { frequencyToDays, frequencyToMilliseconds, timeTillDue, isDue, Due } from './frequencies'

describe('frequencies utilities', () => {
  it('converts named frequencies to days', () => {
    expect(frequencyToDays('daily')).toBe(1)
    expect(frequencyToDays('weekly')).toBe(7)
    expect(frequencyToDays('monthly')).toBeCloseTo(365.25 / 12)
  })

  it('accepts numeric days and converts to milliseconds', () => {
    expect(frequencyToDays(3)).toBe(3)
    expect(frequencyToMilliseconds(2)).toBe(2 * 24 * 60 * 60 * 1000)
  })

  it('computes timeTillDue and isDue thresholds correctly (weekly)', () => {
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000

    const last = new Date(now - (6 * oneDay)) // 6 days ago
    const t = timeTillDue(last, 'weekly')
    expect(t).toBeGreaterThan(0)
    expect(isDue(last, 'weekly')).toBe(Due.due)

    const farPast = new Date(now - (20 * oneDay))
    expect(isDue(farPast, 'weekly')).toBe(Due.overdue)

    const farFuture = new Date(now + (20 * oneDay))
    expect(isDue(farFuture, 'weekly')).toBe(Due.fine)

    const yesterday = new Date(now - oneDay)
    expect(timeTillDue(yesterday, 'weekly'))
    expect(isDue(yesterday, 'weekly')).toBe(Due.fine)
  })

  it('computes timeTillDue and isDue thresholds correctly (daily)', () => {
    const now = Date.now()
    const oneDay = 24 * 60 * 60 * 1000

    const last = new Date(now - (0.5 * oneDay)) // 12 hours ago
    const t = timeTillDue(last, 'daily')
    // due date should be ~0.5 day in future (1 - 0.5)

    expect(t).toBeGreaterThan(0)
    expect(isDue(last, 'daily')).toBe(Due.fine)

    const farPast = new Date(now - (5 * oneDay))
    expect(isDue(farPast, 'daily')).toBe(Due.overdue)

    const farFuture = new Date(now + (5 * oneDay))
    expect(isDue(farFuture, 'daily')).toBe(Due.fine)

    const yesterday = new Date(now - oneDay)
    expect(isDue(yesterday, 'daily')).toBe(Due.due)
  })
})

