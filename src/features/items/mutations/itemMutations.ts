import * as Automerge from '@automerge/automerge'
import { interpretAsDocumentId } from '@automerge/automerge-repo/slim'
import { ERROR_ITEM_TYPE, GroupItem, type Item } from '../../../state/items'
import { ITEM_TYPES, ItemId } from '../../../shared/itemTypes'
import type { AccountMetadata } from '../../../state/metadata'
import { getAccountId } from '../../../api/util'
import { ensureItemsBootstrap } from '../../../api/itemReadService'
import { useNavigationStore } from '../../../state/navigationStore'
import { getAutomergeRepo } from '../../../sync/automergeRepo'
import { toAutomergeUrlFromItemId } from '../../../sync/automergeRepoIds'
import {
  ACCOUNT_METADATA_DOCUMENT_ID,
  applyAutomergeItemPatches,
  applyAutomergeMetadataPatches,
  type AutomergeDocumentPatch,
  getAutomergeItem,
  getAutomergeItems,
  getAutomergeMetadata,
  initializeAutomergeDocStore,
  removeAutomergeItem,
} from '../../../sync/automergeDocStore'
import { requestAutomergeSync } from '../../../sync/automergeSyncDispatcher'

function normalizeItemsInput(items: Item | Item[]): Item[] {
  const incoming = Array.isArray(items) ? items : [items]
  if (incoming.length === 0) {
    throw new Error('Expected at least one item')
  }

  const deduped = new Map<ItemId, Item>()
  for (const item of incoming) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error('Invalid item: missing id')
    }

    if (item.type === ERROR_ITEM_TYPE || !ITEM_TYPES.includes(item.type)) {
      throw new Error(`Invalid item: unsupported type ${String(item.type)}`)
    }

    deduped.set(item.id, item)
  }

  return Array.from(deduped.values())
}

function normalizeItemIds(itemIds: ItemId | ItemId[]): ItemId[] {
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds]
  const normalized = ids
    .filter(id => typeof id === 'string')
    .map(id => id.trim())
    .filter(id => id.length > 0)

  if (normalized.length === 0) {
    throw new Error('Expected at least one item id')
  }

  return Array.from(new Set(normalized))
}

function sanitizeMetadata(metadata: AccountMetadata): AccountMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Invalid metadata payload')
  }

  return metadata
}

function normalizeItemForAutomerge(item: Item): Record<string, unknown> {
  return JSON.parse(JSON.stringify(item)) as Record<string, unknown>
}

function normalizeMetadataForAutomerge(metadata: AccountMetadata): Record<string, unknown> {
  return JSON.parse(JSON.stringify(metadata || {})) as Record<string, unknown>
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!isDeepEqual(left[index], right[index])) {
        return false
      }
    }

    return true
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)

    if (leftKeys.length !== rightKeys.length) {
      return false
    }

    for (const key of leftKeys) {
      if (!isDeepEqual(left[key], right[key])) {
        return false
      }
    }

    return true
  }

  return false
}

function buildTopLevelDocumentPatches(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): AutomergeDocumentPatch[] {
  const patches: AutomergeDocumentPatch[] = []

  for (const key of Object.keys(previous)) {
    if (!(key in next) || next[key] === undefined) {
      patches.push({
        op: 'remove',
        path: [key],
      })
    }
  }

  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) {
      continue
    }

    if (!(key in previous)) {
      patches.push({
        op: 'add',
        path: [key],
        value,
      })
      continue
    }

    if (!isDeepEqual(previous[key], value)) {
      patches.push({
        op: 'replace',
        path: [key],
        value,
      })
    }
  }

  return patches
}

function updateGroupsForDeletedMembers(allItems: Item[], idsSet: Set<ItemId>): Item[] {
  return allItems
    .filter((item): item is GroupItem => item.type === 'group' && item.members.some(memberId => idsSet.has(memberId)))
    .map(group => ({
      ...group,
      members: group.members.filter(memberId => !idsSet.has(memberId)),
    }))
}

function buildDeletionUpdates(allItems: Item[], ids: ItemId[]): Item[] {
  const idsSet = new Set(ids)
  const groupsToUpdate = updateGroupsForDeletedMembers(allItems, idsSet)
  const itemsById = new Map(allItems.map(item => [item.id, item]))

  const tombstones: Item[] = ids.flatMap(id => {
    const item = itemsById.get(id)
    if (!item) {
      return []
    }

    return [{
      ...item,
      deleted: true,
    }]
  })

  return [...groupsToUpdate, ...tombstones]
}

async function ensureAutomergeStoreReady(): Promise<void> {
  await initializeAutomergeDocStore(getAccountId())
}

async function upsertRepoItemSnapshot(item: Item): Promise<void> {
  const repo = getAutomergeRepo()
  const docUrl = toAutomergeUrlFromItemId(item.id)

  let handle = repo.findWithProgress<Record<string, unknown>>(docUrl).handle

  if (handle.isUnavailable()) {
    // `removeFromCache` may throw on unavailable handles; delete clears handle cache entry.
    repo.delete(interpretAsDocumentId(docUrl))

    const initialDoc = Automerge.from(normalizeItemForAutomerge(item))
    const binary = Automerge.save(initialDoc)
    handle = repo.import<Record<string, unknown>>(binary, {
      docId: interpretAsDocumentId(docUrl),
    })
    return
  }

  if (!handle.isReady()) {
    // Best-effort mirror to repo handle; avoid blocking mutations on long readiness waits.
    return
  }

  const normalizedItem = normalizeItemForAutomerge(item)
  handle.change(doc => {
    const draft = doc as Record<string, unknown>

    for (const key of Object.keys(draft)) {
      if (!(key in normalizedItem) || normalizedItem[key] === undefined) {
        delete draft[key]
      }
    }

    for (const [key, value] of Object.entries(normalizedItem)) {
      if (value !== undefined) {
        draft[key] = value
      }
    }
  })
}

function removeRepoItemDocument(itemId: string): void {
  const repo = getAutomergeRepo()
  const docUrl = toAutomergeUrlFromItemId(itemId)

  try {
    repo.delete(docUrl)
  } catch (error) {
    console.error('[itemMutations] Failed to delete repo document', error)
  }
}

let metadataUpdateQueue: Promise<void> = Promise.resolve()

function enqueueMetadataUpdate(task: () => Promise<AccountMetadata>): Promise<AccountMetadata> {
  const operation = metadataUpdateQueue.then(task)
  metadataUpdateQueue = operation.then(
    () => undefined,
    () => undefined,
  )

  return operation
}

export async function storeItems(
  items: Item | Item[],
): Promise<Item[]> {
  const current = normalizeItemsInput(items)
  await ensureAutomergeStoreReady()

  const changedIds: ItemId[] = []

  for (const item of current) {
    const normalizedItem = normalizeItemForAutomerge(item)
    const existingItem = (getAutomergeItem(item.id) as unknown as Record<string, unknown>) || { id: item.id }
    const patches = buildTopLevelDocumentPatches(existingItem, normalizedItem)
    if (patches.length === 0) {
      continue
    }

    await applyAutomergeItemPatches(item.id, patches)
    changedIds.push(item.id)
  }

  if (changedIds.length > 0) {
    await Promise.allSettled(changedIds.map(async itemId => {
      const changedItem = current.find(item => item.id === itemId)
      if (!changedItem) {
        return
      }

      await upsertRepoItemSnapshot(changedItem)
    }))

    requestAutomergeSync(changedIds)
  }

  return current
}

export async function deleteItems(
  itemIds: ItemId | ItemId[],
  options?: {
    allItems?: Item[]
  },
): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)
  await ensureAutomergeStoreReady()

  let allItems = options?.allItems ?? getAutomergeItems()
  if (allItems.length === 0) {
    await ensureItemsBootstrap(getAccountId(), { force: true })
    allItems = getAutomergeItems()
  }

  const updates = buildDeletionUpdates(allItems, ids)

  if (updates.length > 0) {
    await storeItems(updates)
  }

  useNavigationStore.getState().pruneItemDrawers(ids)

  return ids
}

export async function hardDeleteItems(itemIds: ItemId | ItemId[]): Promise<ItemId[]> {
  const ids = normalizeItemIds(itemIds)
  await ensureAutomergeStoreReady()

  for (const itemId of ids) {
    await removeAutomergeItem(itemId)
    removeRepoItemDocument(itemId)
  }

  useNavigationStore.getState().pruneItemDrawers(ids)
  return ids
}

export async function setMetadata(
  metadata: AccountMetadata | ((previous: AccountMetadata) => AccountMetadata),
): Promise<AccountMetadata> {
  return enqueueMetadataUpdate(async () => {
    await ensureAutomergeStoreReady()

    const currentMetadata = getAutomergeMetadata() as AccountMetadata
    const nextMetadata = sanitizeMetadata(
      typeof metadata === 'function'
        ? (metadata as (previous: AccountMetadata) => AccountMetadata)({
          ...currentMetadata,
        })
        : metadata,
    )

    const normalizedMetadata = normalizeMetadataForAutomerge(nextMetadata)
    const patches = buildTopLevelDocumentPatches(
      currentMetadata as Record<string, unknown>,
      normalizedMetadata,
    )

    if (patches.length === 0) {
      return nextMetadata
    }

    await applyAutomergeMetadataPatches(patches)

    requestAutomergeSync([ACCOUNT_METADATA_DOCUMENT_ID])

    return nextMetadata
  })
}
