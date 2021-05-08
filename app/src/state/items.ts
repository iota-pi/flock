import { Action } from 'redux';
import { AllActions } from '.';
import { getItemId } from '../utils';

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
export const UPDATE_ITEMS = 'UPDATE_ITEMS';

export interface SetItemsAction extends Action, ItemsState {
  type: typeof SET_ITEMS | typeof UPDATE_ITEMS,
}

export function setItems(items: Item[]): SetItemsAction {
  return {
    type: SET_ITEMS,
    items,
  };
}

export function updateItems(items: Item[]): SetItemsAction {
  return {
    type: UPDATE_ITEMS,
    items,
  };
}

export function itemsReducer(
  state: Item[] = initialItems,
  action: SetItemsAction | AllActions,
): Item[] {
  if (action.type === SET_ITEMS) {
    return action.items.slice();
  }
  if (action.type === UPDATE_ITEMS) {
    const newState = state.slice();

    // Update existing items
    const updatedItems = new Map(action.items.map(item => [item.id, item]));
    for (let i = 0; i < newState.length; ++i) {
      const matchingItem = updatedItems.get(newState[i].id);
      if (matchingItem) {
        newState.splice(i, 1, matchingItem);
        updatedItems.delete(newState[i].id);
      }
    }

    // Add any new items
    newState.push(...updatedItems.values());
    return newState;
  }

  return state;
}

export function getBlankPerson(id?: string): PersonItem {
  return {
    id: id || getItemId(),
    type: 'person',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    description: '',
    notes: [],
  };
}

export function getItemName(item: Item) {
  if (item.type === 'person') {
    return `${item.firstName} ${item.lastName}`;
  }
  return item.name;
}
