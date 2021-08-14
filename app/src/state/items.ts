import { Action } from 'redux';
import { AllActions } from '.';
import { getItemId } from '../utils';
import { Frequency } from '../utils/frequencies';

export type ItemId = string;
export type ItemType = 'person' | 'group' | 'general';
export type ItemNoteType = 'interaction' | 'prayer' | 'action';
export type ItemOrNoteType = ItemType | ItemNoteType;
export const ITEM_TYPES: ItemType[] = ['person', 'group', 'general'];
export const NOTE_TYPES: ItemNoteType[] = ['interaction', 'prayer', 'action'];

export interface BaseNote {
  content: string,
  date: number,
  id: string,
  sensitive?: boolean,
  type: ItemNoteType,
}
export interface PrayerNote extends BaseNote {
  type: 'prayer',
}
export interface InteractionNote extends BaseNote {
  type: 'interaction',
}
export interface ActionNote extends BaseNote {
  type: 'action',
}
export type ItemNote = PrayerNote | InteractionNote | ActionNote;

export interface BaseItem {
  archived: boolean,
  created: number,
  description: string,
  id: ItemId,
  interactionFrequency: Frequency,
  isNew?: true,
  prayedFor: number[],
  notes: ItemNote[],
  prayerFrequency: Frequency,
  summary: string,
  tags: string[],
  type: ItemType,
}
export interface PersonItem extends BaseItem {
  email: string,
  firstName: string,
  lastName: string,
  maturity: string | null,
  phone: string,
  type: 'person',
}
export interface GroupItem extends BaseItem {
  members: ItemId[],
  name: string,
  type: 'group',
}
export interface GeneralItem extends BaseItem {
  name: string,
  type: 'general',
}
export type Item = PersonItem | GroupItem | GeneralItem;
export type ItemOrNote = Item | ItemNote;

export const initialItems: Item[] = [];
export const initialNoteToItemMap: { [note: string]: ItemId } = {};

export type DirtyItem<T extends Item> = T & { dirty?: boolean };

export interface ItemsState {
  items: Item[],
  noteToItemMap: typeof initialNoteToItemMap,
}

export const SET_ITEMS = 'SET_ITEMS';
export const UPDATE_ITEMS = 'UPDATE_ITEMS';
export const DELETE_ITEMS = 'DELETE_ITEMS';

export interface SetItemsAction extends Action {
  type: typeof SET_ITEMS | typeof UPDATE_ITEMS,
  items: Item[],
}
export interface DeleteItemsAction extends Action {
  type: typeof DELETE_ITEMS,
  items: string[],
}

export type ItemsAction = SetItemsAction | DeleteItemsAction;

export function setItems(items: Item[]): SetItemsAction {
  return {
    type: SET_ITEMS,
    items: items.map(item => supplyMissingAttributes(item)),
  };
}

export function updateItems(items: Item[]): SetItemsAction {
  return { type: UPDATE_ITEMS, items };
}

export function deleteItems(items: string[]): DeleteItemsAction {
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
    const deletedIds = new Set(action.items);
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

export function isItem(itemOrNote: ItemOrNote): itemOrNote is Item {
  return (ITEM_TYPES as ItemOrNoteType[]).includes(itemOrNote.type);
}

export function isNote(itemOrNote: ItemOrNote): itemOrNote is ItemNote {
  return (NOTE_TYPES as ItemOrNoteType[]).includes(itemOrNote.type);
}

export function getBlankBaseNote(): BaseNote {
  return {
    content: '',
    date: new Date().getTime(),
    id: getItemId(),
    type: 'interaction',
  };
}

export function getBlankPrayerPoint(): PrayerNote {
  return {
    ...getBlankBaseNote(),
    type: 'prayer',
  };
}

export function getBlankInteraction(): InteractionNote {
  return {
    ...getBlankBaseNote(),
    type: 'interaction',
  };
}

export function getBlankAction(): ActionNote {
  return {
    ...getBlankBaseNote(),
    type: 'action',
  };
}

export function getBlankNote(noteType: ItemNoteType): ItemNote {
  if (noteType === 'interaction') {
    return getBlankInteraction();
  } else if (noteType === 'prayer') {
    return getBlankPrayerPoint();
  } else if (noteType === 'action') {
    return getBlankAction();
  }
  throw new Error(`Unsupported note type ${noteType}`);
}

function getBlankBaseItem(id?: ItemId): BaseItem {
  return {
    archived: false,
    created: new Date().getTime(),
    description: '',
    id: id || getItemId(),
    interactionFrequency: 'monthly',
    prayedFor: [],
    notes: [],
    prayerFrequency: 'monthly',
    summary: '',
    tags: [],
    type: 'person',
  };
}

export function getBlankPerson(id?: ItemId): PersonItem {
  return {
    ...getBlankBaseItem(id),
    email: '',
    firstName: '',
    isNew: true,
    lastName: '',
    maturity: null,
    phone: '',
    type: 'person',
  };
}

export function getBlankGroup(id?: ItemId): GroupItem {
  return {
    ...getBlankBaseItem(id),
    isNew: true,
    members: [],
    name: '',
    type: 'group',
  };
}

export function getBlankGeneral(id?: ItemId): GeneralItem {
  return {
    ...getBlankBaseItem(id),
    isNew: true,
    name: '',
    type: 'general',
  };
}

export function getBlankItem(itemType: ItemType): Item {
  if (itemType === 'person') {
    return getBlankPerson();
  }
  if (itemType === 'group') {
    return getBlankGroup();
  }
  return getBlankGeneral();
}

export function checkProperties(items: Item[]): { error: boolean, message: string } {
  const ignoreProps: (keyof Item)[] = ['isNew'];
  for (const item of items) {
    const blank = getBlankItem(item.type);
    const filledKeys = Object.keys(item) as (keyof Item)[];
    for (const key of Object.keys(blank) as (keyof Item)[]) {
      if (ignoreProps.includes(key)) {
        continue;
      }

      if (!filledKeys.includes(key)) {
        return {
          error: true,
          message: `Item ${item.id} is missing key "${key}"`,
        };
      }
    }
  }
  return {
    error: false,
    message: 'Success',
  };
}

export function getItemTypeLabel(itemType: ItemType, plural?: boolean): string {
  if (itemType === 'person') {
    return plural ? 'People' : 'Person';
  }
  if (itemType === 'group') {
    return plural ? 'Groups' : 'Group';
  }
  return plural ? 'Items' : 'Item';
}

export function getNoteTypeLabel(itemType: ItemNoteType, plural?: boolean): string {
  if (itemType === 'interaction') {
    return plural ? 'Interactions' : 'Interaction';
  }
  return plural ? 'Prayer Points' : 'Prayer Point';
}

export function getItemName(item?: Partial<Item> & Pick<Item, 'type'>): string {
  if (item === undefined) return '';

  if (item.type === 'person') {
    return `${item.firstName || ''} ${item.lastName || ''}`.trim();
  }
  return (item.name || '').trim();
}

export function comparePeopleNames(a: PersonItem, b: PersonItem) {
  return (
    (+(a.lastName > b.lastName) - +(a.lastName < b.lastName))
    || (+(a.firstName > b.firstName) - +(a.firstName < b.firstName))
  );
}

export function compareNames(
  a: GroupItem | GeneralItem,
  b: GroupItem | GeneralItem,
) {
  return +(a.name > b.name) - +(a.name < b.name);
}

export function compareIds(a: Item | ItemNote, b: Item | ItemNote) {
  return +(a.id > b.id) - +(a.id < b.id);
}

export function compareItems(a: Item, b: Item) {
  if (a.archived !== b.archived) {
    return +a.archived - +b.archived;
  } else if (a.type !== b.type) {
    return ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type);
  } else if (a.type === 'person' || b.type === 'person') {
    return comparePeopleNames(a as PersonItem, b as PersonItem);
  }
  return compareNames(a, b) || compareIds(a, b);
}

export function compareNotes(a: ItemNote, b: ItemNote): number {
  // Sort notes in descending order of date by default
  return b.date - a.date || compareIds(a, b);
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

export function filterArchived<T extends Item>(items: T[]): T[] {
  return items.filter(item => !item.archived);
}

export function getNotes(items: Item[], filterType?: 'prayer'): PrayerNote[];
export function getNotes(items: Item[], filterType?: 'interaction'): InteractionNote[];
export function getNotes(items: Item[], filterType?: ItemNoteType): ItemNote[];
export function getNotes(items: Item[], filterType?: ItemNoteType): ItemNote[] {
  const allNotes = items.flatMap(item => item.notes);
  if (filterType) {
    return allNotes.filter(note => note.type === filterType);
  }
  return allNotes;
}

export function getTags(items: Item[]) {
  return Array.from(new Set(items.flatMap(item => item.tags))).sort();
}

export function supplyMissingAttributes(item: Item): Item {
  return {
    ...getBlankBaseItem(),
    ...item,
  };
}

export function dirtyItem<T extends Item>(item: T): DirtyItem<T> {
  return { ...item, dirty: true };
}

export function cleanItem<T extends Item>(item: DirtyItem<T>): T {
  return { ...item, dirty: undefined, isNew: undefined };
}
