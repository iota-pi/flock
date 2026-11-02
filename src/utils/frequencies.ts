const ONE_DAY = 1000 * 60 * 60 * 24
const DUE_WINDOW_IN_DAYS = 7
const FREQUENCIES_TO_DAYS = {
  daily: 1,
  biweekly: 3.5,
  weekly: 7,
  fortnightly: 14,
  monthly: 365.25 / 12,
  quarterly: 365.25 / 4,
  annually: 365.25,
  none: Infinity,
}
export type BaseFrequency = keyof typeof FREQUENCIES_TO_DAYS
export type Frequency = BaseFrequency | number

export const FREQUENCIES_TO_LABELS: Record<BaseFrequency, string> = {
  daily: 'Daily',
  biweekly: 'Every few days',
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
  none: 'No target',
}
export const FREQUENCIES = Object.keys(FREQUENCIES_TO_DAYS) as BaseFrequency[]

export function frequencyToDays(frequency: Frequency) {
  if (typeof frequency === 'number') return frequency
  return FREQUENCIES_TO_DAYS[frequency]
}

export function frequencyToMilliseconds(frequency: Frequency) {
  return frequencyToDays(frequency) * ONE_DAY
}

export enum Due {
  fine,
  due,
  overdue,
}

export function timeTillDue(lastDate: Date, desiredFrequency: Frequency) {
  const dueDate = new Date(lastDate.getTime() + frequencyToMilliseconds(desiredFrequency))
  return dueDate.getTime() - new Date().getTime()
}

export function isDue(lastDate: Date, desiredFrequency: Frequency): Due {
  const remainingTime = timeTillDue(lastDate, desiredFrequency)
  const threshold = Math.ceil(frequencyToDays(desiredFrequency) / DUE_WINDOW_IN_DAYS) * ONE_DAY
  if (remainingTime < -threshold) {
    return Due.overdue
  }
  if (remainingTime <= (desiredFrequency === 'daily' ? 0 : threshold)) {
    return Due.due
  }
  return Due.fine
}
