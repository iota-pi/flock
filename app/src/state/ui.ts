import { Action, combineReducers } from 'redux';
import { AllActions } from '.';
import { getItemId } from '../utils';
import { DELETE_ITEMS, ItemId, ItemOrNote } from './items';

export interface DrawerData {
  id: string,
  initial?: ItemOrNote[],
  item?: string,
  newItem?: ItemOrNote,
  next?: string[],
  open: boolean,
  praying?: boolean,
  report?: boolean,
}
export interface UiOptions {
  bulkActionsOnMobile: boolean,
}
export interface RequestData {
  active: number,
  error: string,
}
export interface UIData {
  drawers: DrawerData[],
  selected: ItemId[],
  options: UiOptions,
  requests: RequestData,
}
export interface UIState {
  ui: UIData,
}

const initialDrawers: UIData['drawers'] = [];
const initialSelected: UIData['selected'] = [];
const initialFlags: UIData['options'] = {
  bulkActionsOnMobile: false,
};
const initialRequests: UIData['requests'] = {
  active: 0,
  error: '',
};

export const SET_UI_STATE = 'SET_UI_STATE';
export const REPLACE_ACTIVE = 'REPLACE_ACTIVE';
export const UPDATE_ACTIVE = 'UPDATE_ACTIVE';
export const PUSH_ACTIVE = 'PUSH_ACTIVE';
export const REMOVE_ACTIVE = 'REMOVE_ACTIVE';
export const START_REQUEST = 'START_REQUEST';
export const FINISH_REQUEST = 'FINISH_REQUEST';

export type SetUIState = Omit<Partial<UIData>, 'options' | 'requests'> & {
  options?: Partial<UIData['options']>,
  requests?: Partial<UIData['requests']>,
};
export interface SetUIAction extends Action, SetUIState {
  type: typeof SET_UI_STATE,
}
export interface ReplaceActiveItemAction extends Action {
  type: typeof REPLACE_ACTIVE,
  data: Partial<Omit<DrawerData, 'id'>>,
}
export interface UpdateActiveItemAction extends Action {
  type: typeof UPDATE_ACTIVE,
  data: Partial<Omit<DrawerData, 'id'>>,
}
export interface PushActiveItemAction extends Action {
  type: typeof PUSH_ACTIVE,
  data: Pick<DrawerData, 'item'>,
}
export interface RemoveActiveItemAction extends Action {
  type: typeof REMOVE_ACTIVE,
}
export interface StartRequestAction extends Action {
  type: typeof START_REQUEST,
}
export interface FinishRequestAction extends Action {
  type: typeof FINISH_REQUEST,
  error?: string,
}

export type UIAction = (
  SetUIAction
  | ReplaceActiveItemAction
  | UpdateActiveItemAction
  | PushActiveItemAction
  | RemoveActiveItemAction
  | StartRequestAction
  | FinishRequestAction
);

export function setUiState(data: SetUIState): SetUIAction {
  return {
    type: SET_UI_STATE,
    ...data,
  };
}

export function replaceActive(
  data: Partial<Omit<DrawerData, 'id'>>,
): ReplaceActiveItemAction {
  return {
    type: REPLACE_ACTIVE,
    data,
  };
}

export function updateActive(
  data: Partial<Omit<DrawerData, 'id'>>,
): UpdateActiveItemAction {
  return {
    type: UPDATE_ACTIVE,
    data,
  };
}

export type PushActiveOptions = (
  'initial' | 'newItem' | 'next' | 'open' | 'praying' | 'report'
);
export type PushActiveData = (
  Pick<DrawerData, 'item'> & Partial<Pick<DrawerData, PushActiveOptions>>
);
export function pushActive(data: PushActiveData): PushActiveItemAction {
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

export function startRequest(): StartRequestAction {
  return {
    type: START_REQUEST,
  };
}

export function finishRequest(error?: string): FinishRequestAction {
  return {
    type: FINISH_REQUEST,
    error,
  };
}

export function drawersReducer(
  state: UIData['drawers'] = initialDrawers,
  action: AllActions,
): UIData['drawers'] {
  if (action.type === SET_UI_STATE) {
    return action.drawers || state;
  }
  if (action.type === REPLACE_ACTIVE) {
    const lastItem = state.length > 0 ? state[state.length - 1] : undefined;
    const newItem: DrawerData = {
      id: lastItem ? lastItem.id : getItemId(),
      open: true,
      ...action.data,
    };
    return [...state.slice(0, -1), newItem];
  }
  if (action.type === UPDATE_ACTIVE) {
    const lastItem = state.length > 0 ? state[state.length - 1] : undefined;
    const newItem: DrawerData = {
      id: getItemId(),
      open: true,
      ...lastItem,
      ...action.data,
    };
    return [...state.slice(0, -1), newItem];
  }
  if (action.type === PUSH_ACTIVE) {
    const newItem: DrawerData = {
      id: getItemId(),
      open: true,
      ...action.data,
    };
    return [...state, newItem];
  }
  if (action.type === REMOVE_ACTIVE) {
    return state.slice(0, -1);
  }
  if (action.type === DELETE_ITEMS) {
    const newDrawers: typeof state = [];
    let modified = false;
    for (const drawer of state) {
      if (drawer.item && action.items.includes(drawer.item)) {
        modified = true;
      } else if (drawer.next && drawer.next.find(item => !action.items.includes(item))) {
        newDrawers.push({
          ...drawer,
          next: drawer.next.filter(item => !action.items.includes(item)),
        });
        modified = true;
      } else {
        newDrawers.push(drawer);
      }
    }
    return modified ? newDrawers : state;
  }

  return state;
}

export function selectedReducer(
  state: UIData['selected'] = initialSelected,
  action: AllActions,
): UIData['selected'] {
  if (action.type === SET_UI_STATE) {
    return action.selected || state;
  }
  if (action.type === DELETE_ITEMS) {
    const deletedIds = action.items;
    const newState = state.filter(selected => !deletedIds.includes(selected));
    return newState.length === state.length ? state : newState;
  }

  return state;
}

export function optionsReducer(
  state: UIData['options'] = initialFlags,
  action: AllActions,
): UIData['options'] {
  if (action.type === SET_UI_STATE && action.options) {
    return { ...state, ...action.options };
  }

  return state;
}

export function requestsReducer(
  state: UIData['requests'] = initialRequests,
  action: AllActions,
): UIData['requests'] {
  if (action.type === SET_UI_STATE && action.requests) {
    return { ...state, ...action.requests };
  }
  if (action.type === START_REQUEST) {
    return { ...state, active: state.active + 1 };
  }
  if (action.type === FINISH_REQUEST) {
    return {
      ...state,
      active: state.active - 1,
      error: action.error || state.error,
    };
  }

  return state;
}

export const uiReducer = combineReducers<UIData>({
  drawers: drawersReducer,
  selected: selectedReducer,
  options: optionsReducer,
  requests: requestsReducer,
});
