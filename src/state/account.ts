import type { ItemType } from './items'
import type { SortCriterion } from '../utils/customSort'
import type { Frequency } from '../utils/frequencies'

export type AccountId = string

export interface AccountMetadata {
  completedMigrations?: string[],
  prayerGoal?: number,
  sortCriteria?: SortCriterion[];
  defaultPrayerFrequency?: Partial<Record<ItemType, Frequency>>;
  version?: number;
}

export type MetadataKey = keyof AccountMetadata

export interface AccountState {
  account: AccountId,
  loggedIn: boolean,
  initializing: boolean,
}

export const initialState: AccountState = {
  account: '',
  loggedIn: false,
  initializing: true,
}

export const ACCOUNT_SET = 'account/setAccount'

export function setAccount(payload: Partial<AccountState>) {
  return {
    type: ACCOUNT_SET,
    payload,
  }
}

export type AccountAction = ReturnType<typeof setAccount>

export function reduceAccount(state: AccountState, action: AccountAction): AccountState {
  if (action.type === ACCOUNT_SET) {
    return {
      ...state,
      ...action.payload,
    }
  }
  return state
}
