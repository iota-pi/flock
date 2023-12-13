import { createEntityAdapter, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { capitalise, getItemId } from '../utils';
import { Frequency } from '../utils/frequencies';

export type ItemId = string;
export type ItemType = 'person' | 'group' | 'general';
export type MessageType = 'message';
export const ITEM_TYPES: ItemType[] = ['person', 'group', 'general'];
export const MESSAGE_TYPES: MessageType[] = ['message'];
export const ALL_ITEM_TYPES: (ItemType | MessageType)[] = [...ITEM_TYPES, ...MESSAGE_TYPES];

export interface BaseItem {
  archived: boolean,
  created: number,
  description: string,
  id: ItemId,
  isNew?: true,
  prayedFor: number[],
  prayerFrequency: Frequency,
  summary: string,
  tags: string[],
  type: ItemType | MessageType,
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
export interface MessageItem extends BaseItem {
  name: string,
  type: MessageType,
}
export type Item = PersonItem | GroupItem | GeneralItem;
export type TypedFlockItem = Item | MessageItem;

export type DirtyItem<T> = T & { dirty?: boolean };

const itemsAdapter = createEntityAdapter<Item>({
  sortComparer: compareItems,
})

const itemsSlice = createSlice({
  name: 'items',
  initialState: itemsAdapter.getInitialState(),
  reducers: {
    setItems(state, action: PayloadAction<Item[]>) {
      const newItems = action.payload.map(item => supplyMissingAttributes(item));
      itemsAdapter.setAll(state, newItems);
    },
    updateItems(state, action: PayloadAction<Item[]>) {
      itemsAdapter.setMany(state, action.payload);
    },
    deleteItems(state, payload: PayloadAction<ItemId[]>) {
      itemsAdapter.removeMany(state, payload);
    },
  },
});

export const { setItems, updateItems, deleteItems } = itemsSlice.actions;
export default itemsSlice.reducer;

export const {
  selectById: selectItemById,
  selectIds: selectItemIds,
  selectEntities: selectItems,
  selectAll: selectAllItems,
  selectTotal: selectItemCount,
} = itemsAdapter.getSelectors();

export function isItem(item: TypedFlockItem): item is Item {
  return (ITEM_TYPES as TypedFlockItem['type'][]).includes(item.type);
}

export function isMessage(item: TypedFlockItem): item is MessageItem {
  return (MESSAGE_TYPES as TypedFlockItem['type'][]).includes(item.type);
}

function getBlankBaseItem(id?: ItemId): BaseItem {
  return {
    archived: false,
    created: new Date().getTime(),
    description: '',
    id: id || getItemId(),
    prayedFor: [],
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

export function getBlankMessageItem(id?: ItemId, name?: string, isNew = true): MessageItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    name: name || '',
    type: 'message',
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
  a: GroupItem | GeneralItem | MessageItem,
  b: GroupItem | GeneralItem | MessageItem,
) {
  return +(a.name > b.name) - +(a.name < b.name);
}

export function compareIds(a: TypedFlockItem, b: TypedFlockItem) {
  return +(a.id > b.id) - +(a.id < b.id);
}

export function compareItems(a: TypedFlockItem, b: TypedFlockItem) {
  if (a.archived !== b.archived) {
    return +a.archived - +b.archived;
  } else if (a.type !== b.type) {
    return ALL_ITEM_TYPES.indexOf(a.type) - ALL_ITEM_TYPES.indexOf(b.type);
  } else if (a.type === 'person' || b.type === 'person') {
    return comparePeopleNames(a as PersonItem, b as PersonItem) || compareIds(a, b);
  }
  return compareNames(a, b) || compareIds(a, b);
}

export function filterArchived<T extends Item>(items: T[]): T[] {
  return items.filter(item => !item.archived);
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

export function dirtyItem<T extends Partial<TypedFlockItem>>(item: T): DirtyItem<T> {
  return { ...item, dirty: true };
}

export function cleanItem<T extends TypedFlockItem>(item: DirtyItem<T>): T {
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

export function isValid<T extends TypedFlockItem>(item: T) {
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
