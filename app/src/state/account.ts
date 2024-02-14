import { createSlice, PayloadAction } from '@reduxjs/toolkit'
import { SortCriterion } from '../utils/customSort'

export type AccountId = string

export interface AccountMetadata {
  completedMigrations?: string[],
  maturity?: string[],
  prayerGoal?: number,
  sortCriteria?: SortCriterion[];
}

export type MetadataKey = keyof AccountMetadata

export interface AccountState {
  account: AccountId,
  loggedIn: boolean,
  metadata: AccountMetadata,
}

export const initialState: AccountState = {
  account: '',
  metadata: {},
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
        metadata: { ...state.metadata, ...action.payload.metadata },
      }
    },
  },
})

export const { setAccount } = accountSlice.actions

export default accountSlice.reducer
