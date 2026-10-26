import { z } from 'zod'
import type { PageToken } from '@vault/shared'
import { InvalidPageTokenError } from '../../errors'

// Page tokens wrap DynamoDB's LastEvaluatedKey. Clients can read and forge them, which only lets
// them page through their own account's messages, so the keys are validated but not signed.
const SyncMessageKeySchema = z.object({
  syncId: z.string().min(1),
  cursor: z.number().int().min(0),
}).strict()
type SyncMessageKey = z.infer<typeof SyncMessageKeySchema>

const GlobalSyncMessageKeySchema = z.object({
  account: z.string().min(1),
  cursor: z.number().int().min(0),
  syncId: z.string().min(1),
}).strict()
type GlobalSyncMessageKey = z.infer<typeof GlobalSyncMessageKeySchema>

export function encodePageToken(key: Record<string, unknown>): PageToken {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url')
}

export function decodeItemPageToken(token: PageToken, expectedSyncId: string, fromCursor?: number): SyncMessageKey {
  const key = decodePageToken(token, SyncMessageKeySchema)
  if (key.syncId !== expectedSyncId) {
    throw new InvalidPageTokenError(`Page token is for another item: expected ${expectedSyncId}`)
  }
  if (typeof fromCursor === 'number' && key.cursor < fromCursor) {
    throw new InvalidPageTokenError(`Page token cannot start before cursor ${fromCursor}`)
  }
  return key
}

export function decodeGlobalPageToken(token: PageToken, account: string): GlobalSyncMessageKey {
  const key = decodePageToken(token, GlobalSyncMessageKeySchema)
  if (key.account !== account || !key.syncId.startsWith(`${account}#`)) {
    throw new InvalidPageTokenError(`Page token is for another account: expected ${account}`)
  }
  return key
}

function decodePageToken<T>(token: PageToken, schema: z.ZodType<T>): T {
  let key: unknown
  try {
    key = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
  } catch {
    throw new InvalidPageTokenError('Page token is malformed')
  }
  const parsed = schema.safeParse(key)
  if (!parsed.success) {
    throw new InvalidPageTokenError('Page token is malformed')
  }
  return parsed.data
}
