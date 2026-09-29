import type { Item } from 'src/state/items'

export type AutomergeListItem = { id?: string; [key: string]: unknown }

/**
 * Resolves the reconciliation key for a list element.
 * If the element is an object with an `id` string (e.g. Note), returns that `id`.
 * Otherwise returns the item itself (value identity for primitives).
 */
export function getElementKey(item: unknown): unknown {
  if (item != null && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
    return (item as { id: string }).id
  }
  return item
}

/**
 * Updates properties on an existing Automerge object proxy in place.
 * Avoids replacing the object proxy to preserve Automerge Map CRDT identity and concurrent field merges.
 */
export function updateObjectInPlace(
  existingObj: Record<string, unknown>,
  targetObj: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(targetObj)) {
    if (existingObj[key] !== value) {
      if (value === undefined) {
        delete existingObj[key]
      } else {
        existingObj[key] = value
      }
    }
  }
  for (const key of Object.keys(existingObj)) {
    if (!(key in targetObj)) {
      delete existingObj[key]
    }
  }
}

/**
 * Reconciles an Automerge list proxy in place from an incoming target array.
 * Works for both primitive lists (prayedFor, members) and keyed object lists (notes):
 * - Uses common prefix/suffix optimization and key-based LCS sequence diffing.
 * - Preserves existing Automerge Map proxies by updating properties in place.
 * - Applies splices to insert, delete, or reorder elements.
 */
export function reconcileAutomergeList<T = unknown>(
  currentList: T[],
  targetArray: T[],
): void {
  if (!Array.isArray(currentList) || !Array.isArray(targetArray)) {
    return
  }

  // 1. Common prefix
  let prefix = 0
  const currentLen = currentList.length
  const targetLen = targetArray.length

  while (
    prefix < currentLen &&
    prefix < targetLen &&
    getElementKey(currentList[prefix]) === getElementKey(targetArray[prefix])
  ) {
    const curr = currentList[prefix]
    const tgt = targetArray[prefix]
    if (curr != null && typeof curr === 'object' && tgt != null && typeof tgt === 'object') {
      updateObjectInPlace(curr as Record<string, unknown>, tgt as Record<string, unknown>)
    }
    prefix += 1
  }

  // 2. Common suffix
  let currentSuffix = currentLen - 1
  let targetSuffix = targetLen - 1

  while (
    currentSuffix >= prefix &&
    targetSuffix >= prefix &&
    getElementKey(currentList[currentSuffix]) === getElementKey(targetArray[targetSuffix])
  ) {
    const curr = currentList[currentSuffix]
    const tgt = targetArray[targetSuffix]
    if (curr != null && typeof curr === 'object' && tgt != null && typeof tgt === 'object') {
      updateObjectInPlace(curr as Record<string, unknown>, tgt as Record<string, unknown>)
    }
    currentSuffix -= 1
    targetSuffix -= 1
  }

  const deleteCount = currentSuffix - prefix + 1
  const insertItems = targetArray.slice(prefix, targetSuffix + 1)

  // If there are no diffs, nothing to do
  if (deleteCount <= 0 && insertItems.length === 0) {
    return
  }

  // If middle is simple (pure insert, pure delete, or single replacement)
  if (deleteCount <= 1 && insertItems.length <= 1) {
    if (deleteCount === 1 && insertItems.length === 1) {
      const curr = currentList[prefix]
      const tgt = insertItems[0]
      if (
        getElementKey(curr) === getElementKey(tgt) &&
        curr != null &&
        typeof curr === 'object' &&
        tgt != null &&
        typeof tgt === 'object'
      ) {
        updateObjectInPlace(curr as Record<string, unknown>, tgt as Record<string, unknown>)
        return
      }
    }
    currentList.splice(prefix, Math.max(0, deleteCount), ...insertItems)
    return
  }

  // Otherwise, compute LCS on the middle section to minimize unnecessary deletes/inserts
  const currentMiddle = currentList.slice(prefix, currentSuffix + 1)
  const incomingMiddle = insertItems

  const m = currentMiddle.length
  const n = incomingMiddle.length

  // Build LCS matrix based on element key equality
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i < m; i++) {
    const keyCurrent = getElementKey(currentMiddle[i])
    for (let j = 0; j < n; j++) {
      if (keyCurrent === getElementKey(incomingMiddle[j])) {
        dp[i + 1][j + 1] = dp[i][j] + 1
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  // Backtrack to find edit operations
  type Op =
    | { type: 'keep'; oldIdx: number; newIdx: number }
    | { type: 'delete'; oldIdx: number }
    | { type: 'insert'; oldIdx: number; item: T }

  const ops: Op[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && getElementKey(currentMiddle[i - 1]) === getElementKey(incomingMiddle[j - 1])) {
      ops.push({ type: 'keep', oldIdx: i - 1, newIdx: j - 1 })
      i -= 1
      j -= 1
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', oldIdx: i, item: incomingMiddle[j - 1] })
      j -= 1
    } else if (i > 0) {
      ops.push({ type: 'delete', oldIdx: i - 1 })
      i -= 1
    }
  }

  // For kept items in the middle, update properties in place on the object proxy
  for (const op of ops) {
    if (op.type === 'keep') {
      const curr = currentMiddle[op.oldIdx]
      const tgt = incomingMiddle[op.newIdx]
      if (curr != null && typeof curr === 'object' && tgt != null && typeof tgt === 'object') {
        updateObjectInPlace(curr as Record<string, unknown>, tgt as Record<string, unknown>)
      }
    }
  }

  // Group contiguous deletes/inserts by old index
  const editsByOldIdx = new Map<number, { deletes: number; inserts: T[] }>()
  for (const op of ops) {
    if (op.type === 'delete') {
      const entry = editsByOldIdx.get(op.oldIdx) || { deletes: 0, inserts: [] }
      entry.deletes += 1
      editsByOldIdx.set(op.oldIdx, entry)
    } else if (op.type === 'insert') {
      const entry = editsByOldIdx.get(op.oldIdx) || { deletes: 0, inserts: [] }
      entry.inserts.unshift(op.item) // unshift because backtrack goes backwards
      editsByOldIdx.set(op.oldIdx, entry)
    }
  }

  // Apply splices in descending order so earlier indices remain valid
  const sortedIndices = Array.from(editsByOldIdx.keys()).sort((a, b) => b - a)
  for (const oldIdx of sortedIndices) {
    const edit = editsByOldIdx.get(oldIdx)!
    currentList.splice(prefix + oldIdx, edit.deletes, ...edit.inserts)
  }
}

/**
 * Applies updates to an Automerge document draft in place.
 * Ensures array fields (notes, members, prayedFor) are reconciled in place
 * on existing Automerge list proxies rather than replaced with new objects.
 */
export function applyItemUpdatesToDraft(
  draft: Record<string, unknown>,
  updates: Partial<Item>,
): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete draft[key]
    } else if (Array.isArray(value)) {
      if (Array.isArray(draft[key])) {
        // Reconcile existing Automerge list proxy in place
        reconcileAutomergeList(draft[key] as unknown[], value)
      } else {
        // Initialize list
        draft[key] = value
      }
    } else {
      // Scalar assignment
      draft[key] = value
    }
  }
}
