import { v4 as uuidv4 } from 'uuid';

export const APP_NAME = 'PRM';

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

export function getAccountId() {
  return uuidv4();
}

export function getItemId() {
  return uuidv4();
}

export function formatDate(date: Date) {
  return date.toLocaleDateString();
}

export function formatTime(date: Date) {
  const hours = ((date.getHours() % 12) + 1) || 12;
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const amPm = date.getHours() < 12 ? 'am' : 'pm';
  return `${hours}:${minutes}${amPm}`;
}

export function formatDateAndTime(date: Date) {
  return `${formatDate(date)} ${formatTime(date)}`;
}

export function frequencyToDays(frequency: Frequency) {
  return FREQUENCIES_TO_DAYS[frequency];
}

export function frequencyToMilliseconds(frequency: Frequency) {
  return FREQUENCIES_TO_DAYS[frequency] * ONE_DAY;
}
