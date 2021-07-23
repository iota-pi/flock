import { Action, combineReducers } from 'redux';
import { AllActions } from '.';
import { getItemId } from '../utils';
import { Item, ItemNote } from './items';

export interface DrawerData {
  id: string,
  item?: Item | ItemNote,
  report: boolean,
  open: boolean,
}
export interface UIData {
  drawers: DrawerData[],
}
export interface UIState {
  ui: UIData,
}


const initialDrawers: UIData['drawers'] = [];

export const SET_UI_STATE = 'SET_UI_STATE';
export const REPLACE_ACTIVE = 'REPLACE_ACTIVE';
export const PUSH_ACTIVE = 'PUSH_ACTIVE';
export const REMOVE_ACTIVE = 'REMOVE_ACTIVE';

export interface SetUIAction extends Action, Partial<UIData> {
  type: typeof SET_UI_STATE,
}
export interface UpdateActiveItemAction extends Action {
  type: typeof REPLACE_ACTIVE,
  data: Partial<Omit<DrawerData, 'id'>>,
}
export interface PushActiveItemAction extends Action {
  type: typeof PUSH_ACTIVE,
  data: Pick<DrawerData, 'item'>,
}
export interface RemoveActiveItemAction extends Action {
  type: typeof REMOVE_ACTIVE,
}

export type UIAction = (
  SetUIAction | UpdateActiveItemAction | PushActiveItemAction | RemoveActiveItemAction
);

export function setUiState(data: Partial<UIData>): SetUIAction {
  return {
    type: SET_UI_STATE,
    ...data,
  };
}

export function updateActive(
  data: Partial<Omit<DrawerData, 'id'>>,
): UpdateActiveItemAction {
  return {
    type: REPLACE_ACTIVE,
    data: {
      ...data,
      report: data.report === undefined ? false : data.report,
      open: data.open === undefined ? true : data.open,
    },
  };
}

export function pushActive(
  data: Pick<DrawerData, 'item'> & Partial<Pick<DrawerData, 'open' | 'report'>>,
): PushActiveItemAction {
  return {
    type: PUSH_ACTIVE,
    data,
  };
}

export function removeActive(): RemoveActiveItemAction {
  return {
    type: REMOVE_ACTIVE,
  };
}

export function activeItemsReducer(
  state: UIData['drawers'] = initialDrawers,
  action: UIAction | AllActions,
): UIData['drawers'] {
  if (action.type === SET_UI_STATE) {
    return action.drawers || state;
  }
  if (action.type === REPLACE_ACTIVE) {
    const lastItem = state.length > 0 ? state[state.length - 1] : undefined;
    const newItem: DrawerData = {
      id: getItemId(),
      open: true,
      report: false,
      ...lastItem,
      ...action.data,
    };
    return [...state.slice(0, -1), newItem];
  }
  if (action.type === PUSH_ACTIVE) {
    const newItem: DrawerData = {
      id: getItemId(),
      open: true,
      report: false,
      ...action.data,
    };
    return [...state, newItem];
  }
  if (action.type === REMOVE_ACTIVE) {
    return state.slice(0, -1);
  }

  return state;
}

export const uiReducer = combineReducers<UIData>({
  drawers: activeItemsReducer,
});
