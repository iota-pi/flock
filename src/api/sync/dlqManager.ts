import type { z } from 'zod'
import { queryClient, queryKeys } from '../queryClient'
import { type Item, getItemName } from '../../state/items'
import type { ItemId } from '../../shared/itemTypes'
import {
  moveToDeadLetterQueue,
  readDeadLetterQueue,
  writeDeadLetterQueue,
  type QueuedMutation,
} from '../offlineQueueStore'
import {
  PutItemBodySchema,
  PutItemsBatchBodySchema,
} from '../../shared/syncSchemas'

const ResolveBatchPayloadSchema = PutItemBodySchema.pick({ account: true }).extend({
  resolutions: PutItemsBatchBodySchema.shape.items
    .element.pick({ id: true })
    .transform(value => ({ item: value.id }))
    .array(),
})

const QueuePayloadSchema = PutItemBodySchema.or(PutItemsBatchBodySchema).or(ResolveBatchPayloadSchema)

export type DlqTelemetry = {
  timestamp: number
  queueLength: number
  attemptCount?: number
  queuedAt?: number
  payloadSummary?: Record<string, unknown>
}

export function extractTargetIds(payload: unknown): ItemId[] {
  const parsed = QueuePayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return []
  }

  const value = parsed.data
  if ('item' in value) {
    return [value.item as ItemId]
  }
  if ('items' in value) {
    return value.items
      .map(item => item.id as ItemId)
      .sort()
  }
  if ('resolutions' in value) {
    return value.resolutions
      .map(resolution => resolution.item as ItemId)
      .sort()
  }

  return []
}

export function getPayloadTelemetry(payload: unknown): Record<string, unknown> {
  const parsed = QueuePayloadSchema.safeParse(payload)
  if (!parsed.success) {
    return {}
  }

  const typed = parsed.data
  const targetIds = extractTargetIds(payload)

  return {
    account: typeof typed.account === 'string' ? typed.account : undefined,
    item: 'item' in typed ? typed.item : undefined,
    itemIds: targetIds,
    itemCount: 'items' in typed
      ? typed.items.length
      : ('resolutions' in typed ? typed.resolutions.length : undefined),
  }
}

function getMutationActionLabel(mutationType: string): string {
  if (mutationType.includes('delete')) {
    return 'Delete'
  }
  if (mutationType.includes('put') || mutationType.includes('update') || mutationType.includes('resolve')) {
    return 'Update'
  }
  return 'Sync'
}

export function getHumanReadableDlqTitle(mutation: QueuedMutation): string | undefined {
  const targetIds = extractTargetIds(mutation.payload)
  if (targetIds.length === 0) {
    return undefined
  }

  const cachedItems = queryClient.getQueryData<Item[]>(queryKeys.items) || []
  const itemById = new Map(cachedItems.map(item => [item.id, item]))

  const firstItem = itemById.get(targetIds[0])
  const firstName = firstItem ? getItemName(firstItem) || firstItem.id : targetIds[0]
  const action = getMutationActionLabel(mutation.mutationType)

  if (targetIds.length === 1) {
    return `${action} to ${firstName}`
  }

  return `${action} to ${firstName} and ${targetIds.length - 1} more`
}

export async function moveClientErrorMutationToDlq(args: {
  mutation: QueuedMutation
  errorReason: string
  status: number
  telemetry: DlqTelemetry
}): Promise<number> {
  const humanTitle = getHumanReadableDlqTitle(args.mutation)
  await moveToDeadLetterQueue(
    args.mutation.id,
    args.errorReason,
    args.status,
    args.telemetry,
    humanTitle,
  )

  const deadLetterQueue = await readDeadLetterQueue()
  return deadLetterQueue.length
}

export async function moveUnhandledMutationToDlq(args: {
  mutation: QueuedMutation
  status: number
  errorReason: string
  telemetry: DlqTelemetry
}): Promise<number> {
  const deadLetterQueue = await readDeadLetterQueue()
  deadLetterQueue.push({
    ...args.mutation,
    humanTitle: getHumanReadableDlqTitle(args.mutation),
    lastErrorStatus: args.status,
    failedAt: Date.now(),
    errorReason: args.errorReason,
    failureSnapshot: args.telemetry,
  })

  await writeDeadLetterQueue(deadLetterQueue)
  return deadLetterQueue.length
}
