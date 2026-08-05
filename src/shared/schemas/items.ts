import { z } from 'zod'
import { CryptoResultSchema } from './crypto'

export const ITEM_TYPES = ['person', 'group', 'topic'] as const
export const ERROR_ITEM_TYPE = 'error'

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

export const ItemIdSchema = z.string().min(1).trim().brand<'ItemId'>()

export const frequencySchema = z.union([
  z.number(),
  z.enum(FREQUENCY_VALUES),
]).catch('none')

const noteSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  archived: z.boolean(),
  time: z.number().int().positive(),
})

const baseItemSchema = z.looseObject({
  archived: z.boolean(),
  created: z.number().int().positive(),
  deleted: z.boolean().optional(),
  description: z.string(),
  id: ItemIdSchema,
  isNew: z.literal(true).optional(),
  name: z.string(),
  notes: z.array(noteSchema).catch([]),
  prayedFor: z.array(z.number()).catch([]),
  prayerFrequency: frequencySchema,
  type: z.enum(ITEM_TYPES),
})

export const personItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: z.undefined().optional(),
  members: z.undefined().optional(),
  type: z.literal('person'),
})

export const groupItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: frequencySchema,
  memberPrayerTarget: z.enum(['one', 'all']),
  members: z.array(ItemIdSchema),
  type: z.literal('group'),
})

export const topicItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: z.undefined().optional(),
  members: z.undefined().optional(),
  type: z.literal('topic'),
})

export const errorItemSchema = baseItemSchema.omit({ type: true }).extend({
  errorMessage: z.string().optional(),
  memberPrayerFrequency: z.undefined().optional(),
  members: z.undefined().optional(),
  originalType: z.enum(ITEM_TYPES).optional(),
  rawSnapshot: z.record(z.string(), z.unknown()).optional(),
  type: z.literal(ERROR_ITEM_TYPE)
})


export const standardItemSchema = z.discriminatedUnion('type', [
  personItemSchema,
  groupItemSchema,
  topicItemSchema,
])

export type ItemId = z.infer<typeof ItemIdSchema>
export type Note = z.infer<typeof noteSchema>
export type BaseItem = z.infer<typeof baseItemSchema>
export type PersonItem = z.infer<typeof personItemSchema>
export type GroupItem = z.infer<typeof groupItemSchema>
export type TopicItem = z.infer<typeof topicItemSchema>
export type StandardItem = z.infer<typeof standardItemSchema>
export type ErrorItem = z.infer<typeof errorItemSchema>

export const ItemEnvelopeMetadataSchema = z.object({
  type: z.enum(ITEM_TYPES),
  iv: z.string(),
  modified: z.number(),
  deleted: z.boolean().optional(),
  compactedAt: z.number().optional(),
})

export const StandardItemEnvelopeSchema = z.object({
  item: ItemIdSchema,
  cipher: z.undefined().optional(),
  snapshot: CryptoResultSchema,
  metadata: ItemEnvelopeMetadataSchema,
})

export const TombstoneItemEnvelopeSchema = z.object({
  item: ItemIdSchema,
  cipher: z.undefined().optional(),
  snapshot: z.undefined().optional(),
  metadata: ItemEnvelopeMetadataSchema.extend({
    deleted: z.literal(true),
  }),
})

export const GroupLookupDataSchema = z.object({
  groupNames: z.array(z.string()),
  groupIds: z.array(ItemIdSchema),
})

