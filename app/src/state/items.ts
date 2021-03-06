import { Action } from 'redux';
import { AllActions } from '.';
import { capitalise, getItemId } from '../utils';
import { Frequency } from '../utils/frequencies';

export type ItemId = string;
export type ItemType = 'person' | 'group' | 'general';
export type ItemNoteType = 'interaction' | 'action';
export type ItemOrNoteType = ItemType | ItemNoteType;
export type MessageType = 'message';
export const ITEM_TYPES: ItemType[] = ['person', 'group', 'general'];
export const NOTE_TYPES: ItemNoteType[] = ['interaction', 'action'];
export const MESSAGE_TYPES: MessageType[] = ['message'];

export interface BaseNote {
  content: string,
  date: number,
  id: string,
  sensitive?: boolean,
  type: ItemNoteType,
}
export interface InteractionNote extends BaseNote {
  type: 'interaction',
}
export interface ActionNote extends BaseNote {
  type: 'action',
  completed?: number,
}
export type ItemNote = InteractionNote | ActionNote;

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
export interface MessageItem {
  type: MessageType,
  id: string,
  name: string,
  isNew?: boolean,
}
export type Item = PersonItem | GroupItem | GeneralItem;
export type ItemOrNote = Item | ItemNote;
export type TypedFlockItem = Item | ItemNote | MessageItem;

export const initialItems: Item[] = [];
export const initialNoteToItemMap: { [noteId: string]: ItemId } = {};
export const initialItemMap: { [itemId: string]: Item } = {};

export type DirtyItem<T> = T & { dirty?: boolean };

export interface ItemsState {
  items: typeof initialItems,
  noteToItemMap: typeof initialNoteToItemMap,
  itemMap: typeof initialItemMap,
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

export function updateItems(items: Item[], dontUseThisDirectly: boolean): SetItemsAction {
  if (dontUseThisDirectly !== true) {
    throw new Error('Don\'t use updateItems directly! Use `vault.store` instead');
  }
  return { type: UPDATE_ITEMS, items };
}

export function deleteItems(items: string[], dontUseThisDirectly: boolean): DeleteItemsAction {
  if (dontUseThisDirectly !== true) {
    throw new Error('Don\'t use updateItems directly! Use `vault.delete` instead');
  }
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
    const newState = Object.fromEntries(
      action.items.flatMap(item => item.notes.map(n => [n.id, item.id])),
    );
    if (action.type === SET_ITEMS) {
      return newState;
    }
    return { ...state, ...newState };
  }

  return state;
}

export function itemMapReducer(
  state: ItemsState['itemMap'] = initialItemMap,
  action: SetItemsAction | AllActions,
): ItemsState['itemMap'] {
  if (action.type === SET_ITEMS || action.type === UPDATE_ITEMS) {
    const newState = Object.fromEntries(action.items.map(item => [item.id, item]));
    if (action.type === SET_ITEMS) {
      return newState;
    }
    return { ...state, ...newState };
  }
  if (action.type === DELETE_ITEMS) {
    const newState = { ...state };
    for (const id of action.items) {
      delete newState[id];
    }
    return newState;
  }

  return state;
}

export function isItem(itemOrNote: TypedFlockItem): itemOrNote is Item {
  return (ITEM_TYPES as TypedFlockItem['type'][]).includes(itemOrNote.type);
}

export function isNote(itemOrNote: TypedFlockItem): itemOrNote is ItemNote {
  return (NOTE_TYPES as TypedFlockItem['type'][]).includes(itemOrNote.type);
}

export function isMessage(itemOrNote: TypedFlockItem): itemOrNote is MessageItem {
  return (MESSAGE_TYPES as TypedFlockItem['type'][]).includes(itemOrNote.type);
}

export function getBlankBaseNote(): BaseNote {
  return {
    content: '',
    date: new Date().getTime(),
    id: getItemId(),
    type: 'interaction',
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
    interactionFrequency: 'none',
    prayedFor: [],
    notes: [],
    prayerFrequency: 'monthly',
    summary: '',
    tags: [],
    type: 'person',
  };
}

export function getBlankPerson(id?: ItemId, isNew = true): PersonItem {
  return {
    ...getBlankBaseItem(id),
    email: '',
    firstName: '',
    isNew: isNew || undefined,
    lastName: '',
    maturity: null,
    phone: '',
    type: 'person',
  };
}

export function getBlankGroup(id?: ItemId, isNew = true): GroupItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    members: [],
    name: '',
    type: 'group',
  };
}

export function getBlankGeneral(id?: ItemId, isNew = true): GeneralItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    name: '',
    type: 'general',
  };
}

export function getBlankItem(itemType: ItemType, isNew?: boolean): Item {
  if (itemType === 'person') {
    return getBlankPerson(undefined, isNew);
  }
  if (itemType === 'group') {
    return getBlankGroup(undefined, isNew);
  }
  return getBlankGeneral(undefined, isNew);
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

export function getItemName(
  item?: Partial<Item | MessageItem> & Pick<Item | MessageItem, 'type'>,
): string {
  if (item === undefined) return '';

  if (item.type === 'person') {
    return `${item.firstName || ''} ${item.lastName || ''}`.trim();
  }
  return (item.name || '').trim();
}

export function splitName(
  name: string,
  shouldCapitalise = false,
): Pick<PersonItem, 'firstName' | 'lastName'> {
  const nameParts = name.split(/\s+/, 2);
  const firstName = shouldCapitalise ? capitalise(nameParts[0]) : nameParts[0];
  const lastName = shouldCapitalise ? capitalise(nameParts[1] || '') : nameParts[1] || '';
  return { firstName, lastName };
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
    return comparePeopleNames(a as PersonItem, b as PersonItem) || compareIds(a, b);
  }
  return compareNames(a, b) || compareIds(a, b);
}

export function compareNotes(a: ItemNote, b: ItemNote): number {
  // Sort notes in descending order of date by default
  return b.date - a.date || compareIds(a, b);
}

export function filterArchived<T extends Item>(items: T[]): T[] {
  return items.filter(item => !item.archived);
}

export function getNotes(items: Item[], filterType?: 'interaction'): InteractionNote[];
export function getNotes(items: Item[], filterType?: 'action'): ActionNote[];
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
    ...getBlankItem(item.type, false),
    ...item,
  };
}

export function dirtyItem<T extends Partial<Item>>(item: T): DirtyItem<T> {
  return { ...item, dirty: true };
}

export function cleanItem<T extends Item>(item: DirtyItem<T>): T {
  return { ...item, dirty: undefined, isNew: undefined };
}

export function convertItem<T extends Item, S extends Item>(item: T, type: S['type']): S {
  let result = {
    ...getBlankItem(type, false),
    ...item,
    type,
  } as S;
  if (result.type === 'person') {
    if (item.type !== 'person') {
      result = { ...result, ...splitName(item.name) };
    }
  } else if (item.type === 'person') {
    result.name = getItemName(item);
  }
  return result;
}

export function isValid<T extends Item>(item: T) {
  if (item.type === 'person') {
    return !!item.firstName.trim();
  }
  return !!getItemName(item).trim();
}

export function importPeople(data: Record<string, string>[]): PersonItem[] {
  const d = new Date();
  const todaysDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
  const results: PersonItem[] = [];
  for (const row of data) {
    const { firstName, lastName } = (
      row.name
        ? splitName(row.name)
        : { firstName: row.firstname || '', lastName: row.lastname || '' }
    );
    if (`${firstName}${lastName}`.trim() === '') {
      // Skip rows without a name
      continue;
    }

    const blankPerson = getBlankPerson();
    results.push({
      ...blankPerson,
      firstName,
      lastName,
      email: row.email || blankPerson.email,
      phone: row.phone || blankPerson.phone,
      description: row.description || blankPerson.description,
      summary: row.summary || blankPerson.summary,
      tags: [`Imported ${todaysDate}`],
    });
  }
  return results;
}
