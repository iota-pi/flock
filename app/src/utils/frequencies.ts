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
export const FREQUENCIES = Object.keys(FREQUENCIES_TO_DAYS) as Frequency[];

export function frequencyToDays(frequency: Frequency) {
  return FREQUENCIES_TO_DAYS[frequency];
}

export function frequencyToMilliseconds(frequency: Frequency) {
  return FREQUENCIES_TO_DAYS[frequency] * ONE_DAY;
}