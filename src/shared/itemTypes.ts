import { z } from 'zod'
import {
  ITEM_TYPES,
  GroupLookupDataSchema,
} from './schemas/items'

export type ItemType = typeof ITEM_TYPES[number]

export type GroupLookupData = z.infer<typeof GroupLookupDataSchema>

