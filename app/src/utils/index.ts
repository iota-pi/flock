import { v4 as uuidv4 } from 'uuid';

export function getAccountId() {
  return uuidv4();
}

export function getIndividualId() {
  return uuidv4();
}
