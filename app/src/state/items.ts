import { Action } from 'redux';
import { AllActions } from '.';
import { getItemId } from '../utils';

export type ItemId = string;
export type ItemType = 'person' | 'group';
export type ItemNoteType = 'interaction' | 'prayer' | 'general';

export interface ItemNote {
  id: string,
  type: ItemNoteType,
  date: number,
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
export type OneItemType = Item['type'] extends PersonItem['type'] ? PersonItem : GroupItem;

export const initialItems: Item[] = [];

export interface ItemsState {
  items: Item[],
}

export const SET_ITEMS = 'SET_ITEMS';
export const UPDATE_ITEMS = 'UPDATE_ITEMS';
export const DELETE_ITEMS = 'DELETE_ITEMS';

export interface SetItemsAction extends Action, ItemsState {
  type: typeof SET_ITEMS | typeof UPDATE_ITEMS | typeof DELETE_ITEMS,
}

export function setItems(items: Item[]): SetItemsAction {
  return { type: SET_ITEMS, items };
}

export function updateItems(items: Item[]): SetItemsAction {
  return { type: UPDATE_ITEMS, items };
}

export function deleteItems(items: Item[]): SetItemsAction {
  return { type: DELETE_ITEMS, items };
}

export function itemsReducer(
  state: Item[] = initialItems,
  action: SetItemsAction | AllActions,
): Item[] {
  if (action.type === SET_ITEMS) {
    return action.items.slice();
  } else if (action.type === UPDATE_ITEMS) {
    const updatedIds = new Set(action.items.map(item => item.id));
    const untouchedItems = state.filter(item => !updatedIds.has(item.id));
    return [...untouchedItems, ...action.items];
  } else if (action.type === DELETE_ITEMS) {
    const deletedIds = new Set(action.items.map(item => item.id));
    return state.filter(item => !deletedIds.has(item.id));
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

export function getBlankGroup(id?: string): GroupItem {
  return {
    id: id || getItemId(),
    type: 'group',
    name: '',
    description: '',
    notes: [],
    members: [],
  };
}

export function getItemName(item: Item): string {
  if (item.type === 'person') {
    return `${item.firstName} ${item.lastName}`;
  }
  return item.name;
}

export function comparePeopleNames(a: PersonItem, b: PersonItem) {
  return (
    (+(a.lastName > b.lastName) - +(a.lastName < b.lastName))
    || (+(a.firstName > b.firstName) - +(a.firstName < b.firstName))
  );
}

export function compareGroupNames(a: GroupItem, b: GroupItem) {
  return +(a.name > b.name) - +(a.name < b.name);
}

export function getItemById<T extends Item>(items: T[], id: ItemId): T | undefined {
  const result = items.find(item => item.id === id);
  return result;
}

export function lookupItemsById<T extends Item>(items: T[], ids: ItemId[]): T[] {
  const results: T[] = [];
  for (let i = 0; i < ids.length; ++i) {
    const item = getItemById(items, ids[i]);
    if (item) {
      results.push(item);
    }
  }
  return results;
}
