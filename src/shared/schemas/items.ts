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
])

export const noteSchema = z.object({
  id: z.string(),
  text: z.string(),
  archived: z.boolean(),
  time: z.number(),
})

export const baseItemSchema = z.object({
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

export const itemSchema = z.discriminatedUnion('type', [
  personItemSchema,
  groupItemSchema,
  topicItemSchema,
])
