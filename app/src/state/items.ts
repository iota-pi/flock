import { Action } from 'redux';
import { AllActions } from '.';

export type ItemId = string;
export type ItemType = 'person' | 'group';
export type ItemNoteType = 'interaction' | 'prayer' | 'general';

export interface ItemNote {
  id: string,
  type: ItemNoteType,
  date: string,
  content: string,
}

export interface BaseItem {
  id: ItemId,
  type: ItemType,
  description: string,
  notes: ItemNote[],
}
export interface PersonItem extends BaseItem {
  type: 'person',
  firstName: string,
  lastName: string,
  email: string,
  phone: string,
}
export interface GroupItem extends BaseItem {
  type: 'group',
  name: string,
  members: ItemId[],
}
export type Item = PersonItem | GroupItem;

export const initialItems: Item[] = [];

export interface ItemsState {
  items: Item[],
}

export const SET_ITEMS = 'SET_ITEMS';

export interface SetItemsAction extends Action, ItemsState {
  type: typeof SET_ITEMS,
}

export function setItems(items: Item[]): SetItemsAction {
  return {
    type: SET_ITEMS,
    items,
  };
}

export function itemsReducer(
  state: Item[] | undefined,
  action: SetItemsAction | AllActions,
): Item[] {
  if (action.type === SET_ITEMS) {
    return action.items.slice();
  }

  return state === undefined ? initialItems : state;
}
