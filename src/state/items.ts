import { generateItemId } from '../utils'
import { z } from 'zod'
import { mergeWith } from 'lodash-es'
import { ITEM_TYPES } from '../shared/itemTypes'
import type { ItemId, ItemType } from '../shared/itemTypes'

export { ITEM_TYPES }
export const ERROR_ITEM_TYPE = 'error'

import {
  baseItemSchema,
  frequencySchema,
  groupItemSchema,
  itemSchema,
  noteSchema,
  personItemSchema,
  topicItemSchema,
} from '../shared/schemas/items'

export {
  groupItemSchema,
  noteSchema,
  personItemSchema,
  topicItemSchema,
}

export type Note = z.infer<typeof noteSchema>

type StandardBaseItem = z.infer<typeof baseItemSchema>

export type BaseItem = Omit<StandardBaseItem, 'id' | 'type'> & {
  id: ItemId
  type: ItemType | typeof ERROR_ITEM_TYPE
}

export type PersonItem = Omit<z.infer<typeof personItemSchema>, 'id'> & {
  id: ItemId
}

export type GroupItem = Omit<z.infer<typeof groupItemSchema>, 'id' | 'members'> & {
  id: ItemId
  members: ItemId[]
}

export type TopicItem = Omit<z.infer<typeof topicItemSchema>, 'id'> & {
  id: ItemId
}

export type ErrorItem = Omit<BaseItem, 'type'> & {
  errorMessage?: string
  memberPrayerFrequency?: undefined
  members?: undefined
  originalType?: ItemType
  rawSnapshot?: Record<string, unknown>
  type: typeof ERROR_ITEM_TYPE
}

export type StandardItem = PersonItem | GroupItem | TopicItem

export type Item = StandardItem | ErrorItem
type OldItemType = 'general'

export type DirtyItem<T> = T & { dirty?: boolean }

function mergeItemWithDefaults<T extends object>(defaults: T, candidate: unknown): T {
  if (!candidate || typeof candidate !== 'object') {
    return defaults
  }

  return mergeWith({}, defaults, candidate, (currentValue, nextValue) => {
    if (nextValue === undefined) {
      return currentValue
    }

    if (Array.isArray(nextValue)) {
      return nextValue
    }

    return undefined
  }) as T
}

export function isItem(item: Item): item is StandardItem {
  return (ITEM_TYPES as readonly string[]).includes(item.type)
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

function getBlankTopic(id?: ItemId, isNew = true): TopicItem {
  return {
    ...getBlankBaseItem(id),
    isNew: isNew || undefined,
    type: 'topic',
  }
}

export function getBlankItem(itemType: ItemType | OldItemType, isNew?: boolean): StandardItem {
  if (itemType === 'person') {
    return getBlankPerson(undefined, isNew)
  }
  if (itemType === 'group') {
    return getBlankGroup(undefined, isNew)
  }
  if (itemType === 'topic' || itemType === 'general') {
    return getBlankTopic(undefined, isNew)
  }
  throw new Error('Unknown item type')
}

export function checkProperties(items: Item[]): { error: boolean, errors: Array<{ id: string, message: string }> } {
  const errors: Array<{ id: string, message: string }> = []

  for (const [index, item] of items.entries()) {
    const result = itemSchema.safeParse(item)
    if (result.success) {
      continue
    }

    const issue = result.error.issues[0]
    const keyPath = issue.path.join('.')
    const id = typeof item?.id === 'string' && item.id.length > 0
      ? item.id
      : `at index ${index}`
    const suffix = keyPath.length > 0 ? ` at "${keyPath}"` : ''
    const readable = z.prettifyError(result.error).replace(/\n+/g, '; ')

    errors.push({
      id,
      message: `Item ${id} failed schema validation${suffix}: ${readable}`,
    })
  }

  return {
    error: errors.length > 0,
    errors,
  }
}

export function getItemTypeLabel(itemType: Item['type'], plural?: boolean): string {
  if (itemType === 'person') {
    return plural ? 'People' : 'Person'
  }
  if (itemType === 'group') {
    return plural ? 'Groups' : 'Group'
  }
  if (itemType === 'topic') {
    return plural ? 'Topics' : 'Topic'
  }
  if (itemType === ERROR_ITEM_TYPE) {
    return plural ? 'Corrupted Items' : 'Corrupted Item'
  }
  return plural ? 'Items' : 'Item'
}

export function getItemName(
  item?: Partial<Item> & Pick<Item, 'type'>,
): string {
  if (item === undefined) return ''
  return (item.name || '').trim()
}

function compareNames(a: BaseItem, b: BaseItem) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
}

export function compareIds(a: Item, b: Item) {
  return +(a.id > b.id) - +(a.id < b.id)
}

export function compareItems(a: Item, b: Item) {
  if (a.archived !== b.archived) {
    return +a.archived - +b.archived
  } else if (a.type !== b.type) {
    const typeOrder: Item['type'][] = [...ITEM_TYPES, ERROR_ITEM_TYPE]
    return typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type)
  }
  return compareNames(a, b) || compareIds(a, b)
}

export function filterArchived<T extends Item>(items: T[]): T[] {
  return items.filter(item => item.archived !== true)
}

export function supplyMissingAttributes<T extends Item>(item: T): T {
  if (item.type === ERROR_ITEM_TYPE) {
    return item
  }

  const blank = getBlankItem(item.type, false)
  const filled = mergeItemWithDefaults(blank, item)

  return filled as T
}

export function dirtyItem<T extends Partial<Item>>(item: T): DirtyItem<T> {
  return { ...item, dirty: true }
}

export function cleanItem<T extends Item>(item: DirtyItem<T>): T {
  return { ...item, dirty: undefined, isNew: undefined }
}

export function convertItem<T extends Item, S extends StandardItem>(item: T, type: S['type']): S {
  const result = {
    ...getBlankItem(type, false),
    ...item,
    type,
  } as S
  return result
}

export function isValid<T extends Item>(item: T) {
  if (item.type === ERROR_ITEM_TYPE) {
    return false
  }

  return !!getItemName(item).trim()
}

