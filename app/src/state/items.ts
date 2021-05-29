import { Action } from 'redux';
import { AllActions } from '.';
import { getItemId } from '../utils';

export type ItemId = string;
export type ItemType = 'person' | 'group' | 'event';
export type ItemNoteType = 'interaction' | 'prayer' | 'general';
export const ITEM_TYPES: ItemType[] = ['person', 'group', 'event'];

export interface ItemNote<T extends ItemNoteType = ItemNoteType> {
  id: string,
  type: T,
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
export interface EventItem extends BaseItem {
  type: 'event',
  name: string,
}
export type Item = PersonItem | GroupItem | EventItem;

export const initialItems: Item[] = [];
export const initialNoteToItemMap: { [note: string]: ItemId } = {};

export interface ItemsState {
  items: Item[],
  noteToItemMap: typeof initialNoteToItemMap,
}

export const SET_ITEMS = 'SET_ITEMS';
export const UPDATE_ITEMS = 'UPDATE_ITEMS';
export const DELETE_ITEMS = 'DELETE_ITEMS';

export interface SetItemsAction extends Action {
  type: typeof SET_ITEMS | typeof UPDATE_ITEMS | typeof DELETE_ITEMS,
  items: Item[],
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
  state: ItemsState['items'] = initialItems,
  action: SetItemsAction | AllActions,
): ItemsState['items'] {
  if (action.type === SET_ITEMS) {
    return action.items.slice();
  } else if (action.type === UPDATE_ITEMS) {
    const updatedIds = new Set(action.items.map(item => item.id));
    const untouchedItems = state.filter(item => !updatedIds.has(item.id));
    const unqiueItems = action.items.filter(
      (i1, index) => index === action.items.findIndex(i2 => i2.id === i1.id),
    );
    return [...untouchedItems, ...unqiueItems];
  } else if (action.type === DELETE_ITEMS) {
    const deletedIds = new Set(action.items.map(item => item.id));
    return state.filter(item => !deletedIds.has(item.id));
  }

  return state;
}

export function noteToItemMapReducer(
  state: ItemsState['noteToItemMap'] = initialNoteToItemMap,
  action: SetItemsAction | AllActions,
): ItemsState['noteToItemMap'] {
  if (action.type === SET_ITEMS || action.type === UPDATE_ITEMS) {
    const newMap = Object.fromEntries(
      action.items.flatMap(item => item.notes.map(n => [n.id, item.id])),
    );
    if (action.type === SET_ITEMS) {
      return newMap;
    }
    return { ...state, ...newMap };
  }

  return state;
}

export function getBlankNote<T extends ItemNoteType>(type: T): ItemNote<T> {
  return {
    content: '',
    date: new Date().getTime(),
    id: getItemId(),
    type,
  };
}

function getBlankBaseItem(id?: ItemId): BaseItem {
  return {
    description: '',
    id: id || getItemId(),
    notes: [],
    type: 'person',
  };
}

export function getBlankPerson(id?: ItemId): PersonItem {
  return {
    ...getBlankBaseItem(id),
    type: 'person',
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
  };
}

export function getBlankGroup(id?: ItemId): GroupItem {
  return {
    ...getBlankBaseItem(id),
    type: 'group',
    name: '',
    members: [],
  };
}

export function getBlankEvent(id?: ItemId): EventItem {
  return {
    ...getBlankBaseItem(id),
    type: 'event',
    name: '',
  };
}

export function getItemName(item?: Item): string {
  if (item === undefined) return '';

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

export function compareNames(a: GroupItem | EventItem, b: GroupItem | EventItem) {
  return +(a.name > b.name) - +(a.name < b.name);
}

export function compareItems(a: Item, b: Item) {
  if (a.type !== b.type) {
    return ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type);
  } else if (a.type === 'person' || b.type === 'person') {
    return comparePeopleNames(a as PersonItem, b as PersonItem);
  }
  return compareNames(a, b);
}

export function compareNotes(a: ItemNote, b: ItemNote): number {
  // Sort notes in descending order of date by default
  return +(a.date < b.date) - +(a.date > b.date);
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

export function getNotes<T extends ItemNoteType = ItemNoteType>(
  items: Item[],
  filterType?: T,
): ItemNote<T>[] {
  const allNotes = items.flatMap(item => item.notes);
  if (filterType) {
    return allNotes.filter(note => note.type === filterType) as ItemNote<T>[];
  }
  return allNotes as ItemNote<T>[];
}
