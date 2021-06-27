export const ONE_DAY = 1000 * 60 * 60 * 24;
export const FREQUENCIES_TO_DAYS = {
  daily: 1,
  weekly: 7,
  fortnightly: 14,
  monthly: 365.25 / 12,
  quarterly: 365.25 / 4,
  annually: 365.25,
};
export type Frequency = keyof typeof FREQUENCIES_TO_DAYS;
export const FREQUENCIES_TO_LABELS: Record<Frequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  annually: 'Annually',
};
export const FREQUENCIES = Object.keys(FREQUENCIES_TO_DAYS) as Frequency[];

export function frequencyToDays(frequency: Frequency) {
  return FREQUENCIES_TO_DAYS[frequency];
}

export function frequencyToMilliseconds(frequency: Frequency) {
  return FREQUENCIES_TO_DAYS[frequency] * ONE_DAY;
}

export enum Due {
  fine,
  due,
  overdue,
}

export function isDue(lastDate: Date, desiredFrequency: Frequency): Due {
  const dueDate = new Date(lastDate.getTime() + frequencyToMilliseconds(desiredFrequency));
  const timeTillDue = dueDate.getTime() - new Date().getTime();
  const threshold = Math.ceil(frequencyToDays(desiredFrequency) / 7) * ONE_DAY;
  if (timeTillDue < -threshold) {
    return Due.overdue;
  }
  if (timeTillDue < (desiredFrequency === 'daily' ? 0 : threshold)) {
    return Due.due;
  }
  return Due.fine;
}
