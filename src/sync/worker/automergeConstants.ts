import type { $brand } from 'zod'
import type { ItemId } from '../../shared/schemas/items'

export type IndexDocId = string & $brand<'IndexDocId'>
export const ACCOUNT_INDEX_DOCUMENT_ID = '__account_index__' as IndexDocId
export type BackupDocId = ItemId | IndexDocId

