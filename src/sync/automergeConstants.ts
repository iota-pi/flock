import type { ItemId } from 'src/shared/schemas/items'
import type { $brand } from 'zod'

export type IndexDocId = ItemId & $brand<'IndexDocId'>
export const ACCOUNT_INDEX_DOCUMENT_ID = '__account_index__' as IndexDocId
