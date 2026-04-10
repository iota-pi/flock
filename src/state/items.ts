import { generateItemId } from '../utils'
import { z } from 'zod'
import type { Frequency } from '../utils/frequencies'
import { ITEM_TYPES } from '../shared/itemTypes'
import type { ItemId, ItemType } from '../shared/itemTypes'

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

export type DirtyItem<T> = T & { dirty?: boolean }

const FREQUENCY_VALUES = [
  'daily',
  'biweekly',
  'weekly',
  'fortnightly',
  'monthly',
  'quarterly',
  'annually',
  'none',
] as const

const frequencySchema = z.union([
  z.number(),
  z.enum(FREQUENCY_VALUES),
])

const noteSchema = z.object({
  id: z.string(),
  text: z.string(),
  archived: z.boolean(),
  time: z.number(),
})

const baseItemSchema = z.object({
  archived: z.boolean(),
  created: z.number(),
  deleted: z.boolean().optional(),
  description: z.string(),
  id: z.string(),
  isNew: z.literal(true).optional(),
  name: z.string(),
  notes: z.array(noteSchema),
  prayedFor: z.array(z.number()),
  prayerFrequency: frequencySchema,
  type: z.enum(ITEM_TYPES),
})

const personItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: z.undefined().optional(),
  members: z.undefined().optional(),
  type: z.literal('person'),
})

const groupItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: frequencySchema,
  memberPrayerTarget: z.enum(['one', 'all']),
  members: z.array(z.string()),
  type: z.literal('group'),
})

const topicItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: z.undefined().optional(),
  members: z.undefined().optional(),
  type: z.literal('topic'),
})

const itemSchema = z.discriminatedUnion('type', [
  personItemSchema,
  groupItemSchema,
  topicItemSchema,
])

function hasPath(value: unknown, path: (string | number)[]): boolean {
  let current: unknown = value

  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment < 0 || segment >= current.length) {
        return false
      }

      current = current[segment]
      continue
    }

    if (!current || typeof current !== 'object' || !(segment in current)) {
      return false
    }

    current = (current as Record<string, unknown>)[segment]
  }

  return true
}

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

export function getBlankItem(itemType: ItemType | OldItemType, isNew?: boolean): Item {
  if (itemType === 'person' || itemType === 'general') {
    return getBlankPerson(undefined, isNew)
  }
  if (itemType === 'group') {
    return getBlankGroup(undefined, isNew)
  }
  if (itemType === 'topic') {
    return getBlankTopic(undefined, isNew)
  }
  throw new Error('Unknown item type')
}

export function checkProperties(items: Item[]): { error: boolean, message: string } {
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
    const isMissingKey = issue.code === 'invalid_type'
      && keyPath.length > 0
      && !hasPath(item, issue.path as (string | number)[])

    if (isMissingKey) {
      return {
        error: true,
        message: `Item ${id} is missing key "${keyPath}"`,
      }
    }

    const suffix = keyPath.length > 0
      ? ` at "${keyPath}"`
      : ''

    return {
      error: true,
      message: `Item ${id} failed schema validation${suffix}: ${issue.message}`,
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
  const blank = getBlankItem(item.type, false)
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
    ...getBlankItem(type, false),
    ...item,
    type,
  } as S
  return result
}

export function isValid<T extends Item>(item: T) {
  return !!getItemName(item).trim()
}

