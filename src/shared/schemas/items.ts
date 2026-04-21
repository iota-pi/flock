import { z } from 'zod'
import { ITEM_TYPES } from '../itemTypes'

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

export const frequencySchema = z.union([
  z.number(),
  z.enum(FREQUENCY_VALUES),
]).catch('none')

export const noteSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  archived: z.boolean(),
  time: z.number().int().positive(),
})

export const baseItemSchema = z.looseObject({
  archived: z.boolean(),
  created: z.number().int().positive(),
  deleted: z.boolean().optional(),
  description: z.string(),
  id: z.string(),
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
  members: z.array(z.string()),
  type: z.literal('group'),
})

export const topicItemSchema = baseItemSchema.extend({
  memberPrayerFrequency: z.undefined().optional(),
  members: z.undefined().optional(),
  type: z.literal('topic'),
})

export const readItemSchema = z.discriminatedUnion('type', [
  personItemSchema,
  groupItemSchema,
  topicItemSchema,
])

export const insertPersonSchema = personItemSchema.strict()
export const insertGroupSchema = groupItemSchema.strict()
export const insertTopicSchema = topicItemSchema.strict()

export const insertItemSchema = z.discriminatedUnion('type', [
  insertPersonSchema,
  insertGroupSchema,
  insertTopicSchema,
])

export type Note = z.infer<typeof noteSchema>
export type BaseItem = z.infer<typeof baseItemSchema>
export type PersonItem = z.infer<typeof personItemSchema>
export type GroupItem = z.infer<typeof groupItemSchema>
export type TopicItem = z.infer<typeof topicItemSchema>
export type Item = z.infer<typeof readItemSchema>
