import { z } from 'zod'
import { frequencySchema } from './items'


const sortCriterionSchema = z.object({
  type: z.enum([
    'archived',
    'created',
    'description',
    'lastPrayedFor',
    'name',
    'type',
  ]),
  reverse: z.boolean(),
})

const defaultPrayerFrequencySchema = z.object({
  person: frequencySchema.optional(),
  group: frequencySchema.optional(),
  topic: frequencySchema.optional(),
}).partial()

export const accountMetadataSchema = z.looseObject({
  completedMigrations: z.array(z.string()).optional(),
  prayerGoal: z.number().optional(),
  sortCriteria: z.array(sortCriterionSchema).optional(),
  defaultPrayerFrequency: defaultPrayerFrequencySchema.optional(),
})
