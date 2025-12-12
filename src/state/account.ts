import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { SortCriterion } from '../utils/customSort'
import { Frequency } from '../utils/frequencies'

export type AccountId = string

export interface AccountMetadata {
  completedMigrations?: string[],
  prayerGoal?: number,
  sortCriteria?: SortCriterion[];
  defaultPrayerFrequency?: Partial<Record<'person'|'group', Frequency>>;
}

export type MetadataKey = keyof AccountMetadata

export interface AccountState {
  account: AccountId,
  loggedIn: boolean,
}

export const initialState: AccountState = {
  account: '',
  loggedIn: false,
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
