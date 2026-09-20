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
  autoSnoozeWhenCompleted: z.boolean().optional(),
  updatedAt: z.number().optional(),
})

export const SYNCABLE_METADATA_KEYS = [
  'defaultPrayerFrequency',
  'prayerGoal',
  'autoSnoozeWhenCompleted',
  'completedMigrations',
  'updatedAt',
] as const

export type SyncableMetadataKey = (typeof SYNCABLE_METADATA_KEYS)[number]

export function extractSyncableMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {}
  const result: Record<string, unknown> = {}
  for (const key of SYNCABLE_METADATA_KEYS) {
    if (metadata[key] !== undefined) {
      result[key] = metadata[key]
    }
  }
  return result
}

