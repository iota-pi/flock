import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import { SortCriterion } from '../utils/customSort';
import { SMTPConfig } from '../../../koinonia/sender/types';

export type AccountId = string;

export interface EmailSettings extends SMTPConfig {
  email: string,
  name: string,
}
export interface AccountMetadata {
  completedMigrations?: string[],
  maturity?: string[],
  showCommPage?: boolean,
  prayerGoal?: number,
  sortCriteria?: SortCriterion[];
  emailSettings?: EmailSettings;
}

export type MetadataKey = keyof AccountMetadata;

export interface AccountState {
  account: AccountId,
  metadata: AccountMetadata,
}

export const initialState: AccountState = {
  account: '',
  metadata: {},
};

const accountSlice = createSlice({
  name: 'account',
  initialState,
  reducers: {
    setAccount(state, action: PayloadAction<Partial<AccountState>>) {
      return {
        ...state,
        ...action.payload,
        metadata: { ...state.metadata, ...action.payload.metadata },
      };
    },
  },
});

export const { setAccount } = accountSlice.actions;

export default accountSlice.reducer;
