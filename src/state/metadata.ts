import type { ItemType } from './items'
import type { SortCriterion } from '../utils/customSort'
import type { Frequency } from '../utils/frequencies'

export interface AccountMetadata {
  completedMigrations?: string[],
  prayerGoal?: number,
  sortCriteria?: SortCriterion[];
  defaultPrayerFrequency?: Partial<Record<ItemType, Frequency>>;
}

export type MetadataKey = keyof AccountMetadata