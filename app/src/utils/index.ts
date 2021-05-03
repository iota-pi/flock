import { v4 as uuidv4 } from 'uuid';

export const APP_NAME = 'PRM';

export function getAccountId() {
  return uuidv4();
}

export function getIndividualId() {
  return uuidv4();
}
