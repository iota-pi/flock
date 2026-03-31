import { z } from 'zod'

export const ItemTypeSchema = z.enum(['person', 'group', 'topic'])

export const WebPushSubscriptionKeysSchema = z.object({
  p256dh: z.string(),
  auth: z.string(),
})

export const WebPushSubscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: WebPushSubscriptionKeysSchema,
})

/**
 * VaultBranch: Represents a single Automerge branch in the new branching format
 */
export const VaultBranchSchema = z.object({
  encryptedAutomergeDoc: z.string(), // Base64-encoded Uint8Array
  versionId: z.string().min(1),
  parentIds: z.array(z.string()),
})

export const CreateAccountBodySchema = z.object({
  salt: z.string().min(1),
  authToken: z.string().min(1),
})

export const LoginBodySchema = z.object({
  account: z.string().min(1),
  authToken: z.string().min(1),
})

export const AccountInputSchema = z.object({
  account: z.string().min(1),
})

export const UpdateMetadataBodySchema = z.object({
  account: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

/**
 * PutItemBodySchema: Branch-only payload
 */
export const PutItemBodySchema = z.object({
  account: z.string().min(1),
  item: z.string().min(1),
  modified: z.number(),
  type: z.string(),
  branches: z.array(VaultBranchSchema).min(1),
  deleted: z.boolean().optional(),
  idempotencyKey: z.string().min(1).optional(),
})

export const CompactItemBodySchema = z.object({
  account: z.string().min(1),
  item: z.string().min(1),
  baseVersionId: z.string().min(1),
  compactedBranch: VaultBranchSchema,
  idempotencyKey: z.string().min(1).optional(),
})

/**
 * PutItemsBatchEntrySchema: Branch-only payload
 */
export const PutItemsBatchEntrySchema = z.object({
  id: z.string().min(1),
  modified: z.number(),
  type: z.string(),
  branches: z.array(VaultBranchSchema).min(1),
  deleted: z.boolean().optional(),
})

export const PutItemsBatchBodySchema = z.object({
  account: z.string().min(1),
  items: z.array(PutItemsBatchEntrySchema),
  idempotencyKey: z.string().min(1).optional(),
})

export const FetchItemsInputSchema = z.object({
  account: z.string().min(1),
  cacheTime: z.number().nullable().optional(),
  ids: z.array(z.string()).optional(),
})

export const FetchItemHistoryInputSchema = z.object({
  account: z.string().min(1),
  itemId: z.string().min(1),
  limit: z.number().int().positive().max(100).optional(),
})

export const PushSubscriptionBodySchema = z.object({
  account: z.string().min(1),
  endpoint: z.string().min(1),
  keys: WebPushSubscriptionKeysSchema,
})

export const PushSubscriptionDeleteBodySchema = z.object({
  account: z.string().min(1),
  endpoint: z.string().min(1),
})

export const ReminderSettingsBodySchema = z.object({
  account: z.string().min(1),
  reminderEnabled: z.boolean(),
  reminderTime: z.string().min(5).max(5),
  reminderTimezone: z.string().min(1),
})

export const PrayerCompletionBodySchema = z.object({
  account: z.string().min(1),
  completedAt: z.number(),
})

/**
 * ResolveBranchConflictSchema: Submit a single merged branch to replace multiple branches
 * Used when a client detects and merges multiple branches
 */
export const ResolveBranchConflictSchema = z.object({
  account: z.string().min(1),
  item: z.string().min(1),
  resolvedBranch: VaultBranchSchema,
  idempotencyKey: z.string().min(1).optional(),
})

/**
 * ResolveBatchConflictsSchema: Bulk resolution for multiple items with conflicts
 * All items must have their branches merged into a single branch
 */
export const ResolveBatchConflictsSchema = z.object({
  account: z.string().min(1),
  resolutions: z.array(z.object({
    item: z.string().min(1),
    resolvedBranch: VaultBranchSchema,
  })),
  idempotencyKey: z.string().min(1).optional(),
})