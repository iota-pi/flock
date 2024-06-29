import { createEntityAdapter, createSlice, PayloadAction } from '@reduxjs/toolkit'
import { generateItemId } from '../utils'
import { Frequency } from '../utils/frequencies'
import { RootState } from '../store'

export type ItemId = string
export type ItemType = 'person' | 'group'
export type OldItemType = 'general'
export const ITEM_TYPES: ItemType[] = ['person', 'group']

export interface BaseItem {
  archived: boolean,
  created: number,
  description: string,
  id: ItemId,
  isNew?: true,
  name: string,
  prayedFor: number[],
  prayerFrequency: Frequency,
  summary: string,
  type: ItemType,
}
export interface PersonItem extends BaseItem {
  memberPrayerFrequency?: undefined,
  members?: undefined,
  type: 'person',
}
export interface GroupItem extends BaseItem {
  memberPrayerFrequency: Frequency,
  members: ItemId[],
  type: 'group',
}
export type Item = PersonItem | GroupItem

export type DirtyItem<T> = T & { dirty?: boolean }

const itemsAdapter = createEntityAdapter<Item>({
  sortComparer: compareItems,
})

const itemsSlice = createSlice({
  name: 'items',
  initialState: itemsAdapter.getInitialState(),
  reducers: {
    setItems(state, action: PayloadAction<Item[]>) {
      const newItems = action.payload.map(item => supplyMissingAttributes(item))
      itemsAdapter.setAll(state, newItems)
    },
    updateItems(state, action: PayloadAction<Item[]>) {
      itemsAdapter.setMany(state, action.payload)
    },
    deleteItems(state, payload: PayloadAction<ItemId[]>) {
      itemsAdapter.removeMany(state, payload)
    },
  },
})

export const { setItems, updateItems, deleteItems } = itemsSlice.actions
export default itemsSlice.reducer

export const {
  selectById: selectItemById,
  selectIds: selectItemIds,
  selectEntities: selectItems,
  selectAll: selectAllItems,
  selectTotal: selectItemCount,
} = itemsAdapter.getSelectors((state: RootState) => state.items)

export function isItem(item: Item): item is Item {
  return (ITEM_TYPES as Item['type'][]).includes(item.type)
}

function getBlankBaseItem(id?: ItemId): BaseItem {
  return {
    archived: false,
    created: new Date().getTime(),
    description: '',
    id: id || generateItemId(),
    name: '',
    prayedFor: [],
    prayerFrequency: 'monthly',
    summary: '',
    type: 'person',
  }
}

export function getBlankPerson(id?: ItemId, isNew = true): PersonItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    type: 'person',
  }
}

export function getBlankGroup(id?: ItemId, isNew = true): GroupItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    members: [],
    memberPrayerFrequency: 'none',
    type: 'group',
  }
}

export function getBlankItem(itemType: ItemType | OldItemType, isNew?: boolean): Item {
  if (itemType === 'person' || itemType === 'general') {
    return getBlankPerson(undefined, isNew)
  }
  if (itemType === 'group') {
    return getBlankGroup(undefined, isNew)
  }
  throw new Error('Unknown item type')
}

export function checkProperties(items: Item[]): { error: boolean, message: string } {
  const ignoreProps: (keyof Item)[] = ['isNew']
  for (const item of items) {
    const blank = getBlankItem(item.type)
    const filledKeys = Object.keys(item) as (keyof Item)[]
    for (const key of Object.keys(blank) as (keyof Item)[]) {
      if (ignoreProps.includes(key)) {
        continue
      }

      if (!filledKeys.includes(key)) {
        return {
          error: true,
          message: `Item ${item.id} is missing key "${key}"`,
        }
      }
    }
  }
  return {
    error: false,
    message: 'Success',
  }
}

export function getItemTypeLabel(itemType: ItemType, plural?: boolean): string {
  if (itemType === 'person') {
    return plural ? 'People' : 'Person'
  }
  if (itemType === 'group') {
    return plural ? 'Groups' : 'Group'
  }
  return plural ? 'Items' : 'Item'
}

export function getItemName(
  item?: Partial<Item> & Pick<Item, 'type'>,
): string {
  if (item === undefined) return ''
  return (item.name || '').trim()
}

export function compareNames(a: BaseItem, b: BaseItem) {
  return +(a.name > b.name) - +(a.name < b.name)
}

export function compareIds(a: Item, b: Item) {
  return +(a.id > b.id) - +(a.id < b.id)
}

export function compareItems(a: Item, b: Item) {
  if (a.archived !== b.archived) {
    return +a.archived - +b.archived
  } else if (a.type !== b.type) {
    return ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type)
  }
  return compareNames(a, b) || compareIds(a, b)
}

export function filterArchived<T extends Item>(items: T[]): T[] {
  return items.filter(item => !item.archived)
}

export function supplyMissingAttributes<T extends Item>(item: T): T {
  return {
    ...getBlankItem(item.type, false),
    ...item,
  }
}

export function dirtyItem<T extends Partial<Item>>(item: T): DirtyItem<T> {
  return { ...item, dirty: true }
}

export function cleanItem<T extends Item>(item: DirtyItem<T>): T {
  return { ...item, dirty: undefined, isNew: undefined }
}

export function convertItem<T extends Item, S extends Item>(item: T, type: S['type']): S {
  const result = {
    ...getBlankItem(type, false),
    ...item,
    type,
  } as S
  return result
}

export function isValid<T extends Item>(item: T) {
  return !!getItemName(item).trim()
}

export function importPeople(data: Record<string, string>[]): Item[] {
  const d = new Date()
  const todaysDate = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`
  const importGroup = getBlankGroup()
  importGroup.name = `Imported ${todaysDate}`
  const results: Item[] = [
    importGroup,
  ]
  for (const row of data) {
    const name = (row.name || `${row.firstName} ${row.lastName}`).trim()
    if (name === '') {
      // Skip rows without a name
      continue
    }

    const blankPerson = getBlankPerson()
    results.push({
      ...blankPerson,
      name,
      description: row.description || blankPerson.description,
      summary: row.summary || blankPerson.summary,
    })
    importGroup.members.push(blankPerson.id)
  }
  return results
}
