import { v4 as uuidv4 } from 'uuid';

export const APP_NAME = 'PRM';

export function getAccountId() {
  return uuidv4();
}

export function getItemId() {
  return uuidv4();
}

export function formatDateAndTime(date: Date) {
  const hours = ((date.getHours() % 12) + 1) || 12;
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const amPm = date.getHours() < 12 ? 'am' : 'pm';
  const dateString = date.toLocaleDateString();
  return `${dateString} ${hours}:${minutes}${amPm}`;
}
