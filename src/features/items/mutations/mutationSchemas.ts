import { z } from 'zod'
import { ITEM_TYPES, type ItemId } from '../../../shared/itemTypes'
import type { Item } from '../../../state/items'
import { FREQUENCIES } from '../../../utils/frequencies'

const FrequencySchema = z.union([
  z.enum(FREQUENCIES),
  z.number(),
])

const NoteSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  archived: z.boolean(),
  time: z.number(),
})

const BaseItemSchema = z.object({
  archived: z.boolean(),
  created: z.number(),
  deleted: z.boolean().optional(),
  description: z.string(),
  id: z.string().min(1),
  isNew: z.literal(true).optional(),
  name: z.string(),
  notes: z.array(NoteSchema),
  prayedFor: z.array(z.number()),
  prayerFrequency: FrequencySchema,
})

const PersonItemSchema = BaseItemSchema.extend({
  type: z.literal('person'),
})

const TopicItemSchema = BaseItemSchema.extend({
  type: z.literal('topic'),
})

const GroupItemSchema = BaseItemSchema.extend({
  type: z.literal('group'),
  members: z.array(z.string().min(1)),
  memberPrayerFrequency: FrequencySchema,
  memberPrayerTarget: z.enum(['one', 'all']),
})

export const ItemMutationSchema = z.discriminatedUnion('type', [
  PersonItemSchema,
  GroupItemSchema,
  TopicItemSchema,
])

export const StoreItemsMutationInputSchema = z.union([
  ItemMutationSchema,
  z.array(ItemMutationSchema).min(1),
])

export const ItemIdsMutationInputSchema = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
])

export function parseStoreItemsMutationInput(input: Item | Item[]): Item[] {
  const parsed = StoreItemsMutationInputSchema.parse(input)
  return Array.isArray(parsed) ? parsed as Item[] : [parsed as Item]
}

export function parseItemIdsMutationInput(input: ItemId | ItemId[]): ItemId[] {
  const parsed = ItemIdsMutationInputSchema.parse(input)
  return Array.isArray(parsed) ? parsed : [parsed]
}

export const MetadataMutationInputSchema = z.record(z.string(), z.unknown())

export function parseMetadataMutationInput<T extends object>(input: T): T {
  return MetadataMutationInputSchema.parse(input as Record<string, unknown>) as T
}

export const ItemDomainSchema = z.enum(ITEM_TYPES)
