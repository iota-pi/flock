import type { z } from 'zod'
import type { accountMetadataSchema } from '../shared/schemas/metadata'

export type AccountMetadata = z.infer<typeof accountMetadataSchema>

export type MetadataKey = keyof AccountMetadata