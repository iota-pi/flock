import { generateItemId } from '../utils'
import type { Frequency } from '../utils/frequencies'
import { ITEM_TYPES } from '../shared/itemTypes'
import type { ItemId, ItemType } from '../shared/itemTypes'
import * as Automerge from '@automerge/automerge'
import { setCachedAutomergeBinary } from '../api/automergeBinaryCache'

export { ITEM_TYPES }
export type OldItemType = 'general'

export interface Note {
  id: string
  text: string
  archived: boolean
  time: number
}

export interface BaseItem {
  archived: boolean,
  created: number,
  deleted?: boolean,
  description: string,
  id: ItemId,
  isNew?: true,
  name: string,
  notes: Note[],
  prayedFor: number[],
  prayerFrequency: Frequency,
  type: ItemType,
}
export interface PersonItem extends BaseItem {
  memberPrayerFrequency?: undefined,
  members?: undefined,
  type: 'person',
}
export interface GroupItem extends BaseItem {
  memberPrayerFrequency: Frequency,
  memberPrayerTarget: 'one' | 'all',
  members: ItemId[],
  type: 'group',
}
export interface TopicItem extends BaseItem {
  memberPrayerFrequency?: undefined,
  members?: undefined,
  type: 'topic',
}
export type Item = (PersonItem | GroupItem | TopicItem) & {
}

function seedAutomergeBinary<T extends Item>(item: T): T {
  const doc = Automerge.from(item as unknown as Record<string, unknown>)
  const binary = Automerge.save(doc)
  setCachedAutomergeBinary(item.id, binary)
  return item
}

export type DirtyItem<T> = T & { dirty?: boolean }

export function isItem(item: Item): item is Item {
  return (ITEM_TYPES as readonly Item['type'][]).includes(item.type)
}

function getBlankBaseItem(id?: ItemId): BaseItem {
  return {
    archived: false,
    created: new Date().getTime(),
    description: '',
    id: id || generateItemId(),
    name: '',
    notes: [],
    prayedFor: [],
    prayerFrequency: 'none',
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
    memberPrayerTarget: 'one',
    type: 'group',
  }
}

export function getBlankTopic(id?: ItemId, isNew = true): TopicItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    type: 'topic',
  }
}

export function getBlankItem(itemType: ItemType | OldItemType, isNew?: boolean, seedGenesis = true): Item {
  const maybeSeed = <T extends Item>(item: T): T => (seedGenesis ? seedAutomergeBinary(item) : item)

  if (itemType === 'person' || itemType === 'general') {
    return maybeSeed(getBlankPerson(undefined, isNew))
  }
  if (itemType === 'group') {
    return maybeSeed(getBlankGroup(undefined, isNew))
  }
  if (itemType === 'topic') {
    return maybeSeed(getBlankTopic(undefined, isNew))
  }
  throw new Error('Unknown item type')
}

export function checkProperties(items: Item[]): { error: boolean, message: string } {
  const ignoreProps: (keyof Item)[] = ['isNew']
  for (const item of items) {
    const blank = getBlankItem(item.type, undefined, false)
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
  if (itemType === 'topic') {
    return plural ? 'Topics' : 'Topic'
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
  const blank = getBlankItem(item.type, false, false)
  const filled = {
    ...blank,
    ...item,
  }

  return filled
}

export function dirtyItem<T extends Partial<Item>>(item: T): DirtyItem<T> {
  return { ...item, dirty: true }
}

export function cleanItem<T extends Item>(item: DirtyItem<T>): T {
  return { ...item, dirty: undefined, isNew: undefined }
}

export function convertItem<T extends Item, S extends Item>(item: T, type: S['type']): S {
  const result = {
    ...getBlankItem(type, false, false),
    ...item,
    type,
  } as S
  return result
}

export function isValid<T extends Item>(item: T) {
  return !!getItemName(item).trim()
}

