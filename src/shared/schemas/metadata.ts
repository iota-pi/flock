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

/** Settings that sync across devices through the encrypted settings document. Other keys stay on the device. */
export const SYNCED_METADATA_KEYS = [
  'defaultPrayerFrequency',
  'prayerGoal',
  'autoSnoozeWhenCompleted',
  'completedMigrations',
] as const satisfies readonly (keyof z.infer<typeof accountMetadataSchema>)[]

/** Settings the server stored in plaintext before the settings document, plus the timestamp used to merge them */
export const LEGACY_SYNCABLE_METADATA_KEYS = [
  ...SYNCED_METADATA_KEYS,
  'updatedAt',
] as const satisfies readonly (keyof z.infer<typeof accountMetadataSchema>)[]

type LegacySyncableMetadataKey = (typeof LEGACY_SYNCABLE_METADATA_KEYS)[number]
export type LegacySyncableMetadata = Pick<z.infer<typeof accountMetadataSchema>, LegacySyncableMetadataKey>

export function extractLegacySyncableMetadata(
  metadata: Record<string, unknown> | undefined,
): LegacySyncableMetadata {
  if (!metadata || typeof metadata !== 'object') return {}
  const result: LegacySyncableMetadata = {}
  for (const key of LEGACY_SYNCABLE_METADATA_KEYS) {
    if (metadata[key] !== undefined) {
      result[key] = metadata[key] as never
    }
  }
  return result
}
