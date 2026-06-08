import type { $brand } from 'zod'

export type IndexDocId = string & $brand<'IndexDocId'>
export const ACCOUNT_INDEX_DOCUMENT_ID = '__account_index__' as IndexDocId
