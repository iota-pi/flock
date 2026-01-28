import { createSlice, PayloadAction } from '@reduxjs/toolkit'
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

const accountSlice = createSlice({
  name: 'account',
  initialState,
  reducers: {
    setAccount(state, action: PayloadAction<Partial<AccountState>>) {
      return {
        ...state,
        ...action.payload,
      }
    },
  },
})

export const { setAccount } = accountSlice.actions

export default accountSlice.reducer
