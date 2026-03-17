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
