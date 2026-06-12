import { z } from 'zod'
import { accountMetadataSchema } from '../shared/schemas/metadata'

export type AccountMetadata = z.infer<typeof accountMetadataSchema>

export type MetadataKey = keyof AccountMetadata