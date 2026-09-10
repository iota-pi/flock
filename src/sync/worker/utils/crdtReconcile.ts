import type { Item } from 'src/state/items'

/**
 * Reconciles an Automerge list of primitive values (strings, numbers, booleans)
 * using prefix/suffix optimization and LCS sequence diffing.
 * Applies in-place mutations (splice) to preserve unchanged elements and their CRDT identity.
 */
export function reconcilePrimitiveArray<T>(
  currentList: T[],
  targetArray: T[],
): void {
  // 1. Common prefix
  let prefix = 0
  const currentLen = currentList.length
  const targetLen = targetArray.length

  while (
    prefix < currentLen &&
    prefix < targetLen &&
    currentList[prefix] === targetArray[prefix]
  ) {
    prefix++
  }

  // 2. Common suffix
  let currentSuffix = currentLen - 1
  let targetSuffix = targetLen - 1

  while (
    currentSuffix >= prefix &&
    targetSuffix >= prefix &&
    currentList[currentSuffix] === targetArray[targetSuffix]
  ) {
    currentSuffix--
    targetSuffix--
  }

  const deleteCount = currentSuffix - prefix + 1
  const insertItems = targetArray.slice(prefix, targetSuffix + 1)

  // If there are no diffs, nothing to do
  if (deleteCount <= 0 && insertItems.length === 0) {
    return
  }

  // If middle is simple (pure insert, pure delete, or single replacement)
  if (deleteCount <= 1 || insertItems.length <= 1) {
    currentList.splice(prefix, Math.max(0, deleteCount), ...insertItems)
    return
  }

  // Otherwise, compute LCS on the middle section to minimize unnecessary deletes/inserts
  const currentMiddle = currentList.slice(prefix, currentSuffix + 1)
  const incomingMiddle = insertItems

  const m = currentMiddle.length
  const n = incomingMiddle.length

  // Build LCS matrix
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (currentMiddle[i] === incomingMiddle[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  // Backtrack to find edit operations
  type Op = { type: 'keep' } | { type: 'delete'; oldIdx: number } | { type: 'insert'; oldIdx: number; item: T }
  const ops: Op[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && currentMiddle[i - 1] === incomingMiddle[j - 1]) {
      ops.push({ type: 'keep' })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'insert', oldIdx: i, item: incomingMiddle[j - 1] })
      j--
    } else if (i > 0) {
      ops.push({ type: 'delete', oldIdx: i - 1 })
      i--
    }
  }

  // Group contiguous deletes/inserts by old index
  const editsByOldIdx = new Map<number, { deletes: number; inserts: T[] }>()
  for (const op of ops) {
    if (op.type === 'delete') {
      const entry = editsByOldIdx.get(op.oldIdx) || { deletes: 0, inserts: [] }
      entry.deletes++
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
 * Reconciles an Automerge list of keyed objects (e.g. Note with an `id` field).
 * - Identifies deleted items and removes them backwards via .splice()
 * - Updates existing items in-place on the Automerge object proxy
 * - Inserts brand new items at their respective target positions
 */
export function reconcileKeyedArray<T extends { id?: string; [key: string]: any }>(
  currentList: T[],
  targetArray: T[],
): void {
  const targetIdSet = new Set(
    targetArray
      .filter(item => item != null && typeof item === 'object' && typeof item.id === 'string')
      .map(item => item.id)
  )

  // 1. Delete removed items backwards to keep indices stable
  for (let i = currentList.length - 1; i >= 0; i--) {
    const item = currentList[i]
    if (item != null && typeof item === 'object' && typeof item.id === 'string') {
      if (!targetIdSet.has(item.id)) {
        currentList.splice(i, 1)
      }
    }
  }

  // 2. Map existing items by id
  const existingMap = new Map<string, T>()
  for (let i = 0; i < currentList.length; i++) {
    const item = currentList[i]
    if (item?.id) {
      existingMap.set(item.id, item)
    }
  }

  // 3. Update existing items in place or insert new items
  for (let i = 0; i < targetArray.length; i++) {
    const targetItem = targetArray[i]
    if (targetItem == null || typeof targetItem !== 'object') {
      continue
    }

    const existingItem = targetItem.id ? existingMap.get(targetItem.id) : undefined
    if (existingItem) {
      const existingObj = existingItem as Record<string, any>
      // Update properties in place on the existing Automerge object proxy
      for (const [key, value] of Object.entries(targetItem)) {
        if (existingObj[key] !== value) {
          if (value === undefined) {
            delete existingObj[key]
          } else {
            existingObj[key] = value
          }
        }
      }
      for (const key of Object.keys(existingObj)) {
        if (!(key in targetItem)) {
          delete existingObj[key]
        }
      }
    } else {
      // New item: insert at index i
      if (i < currentList.length) {
        currentList.splice(i, 0, targetItem)
      } else {
        currentList.push(targetItem)
      }
      if (targetItem.id) {
        existingMap.set(targetItem.id, currentList[i])
      }
    }
  }
}

/**
 * Reconciles an Automerge list proxy in place from an incoming target array.
 */
export function reconcileAutomergeList(
  currentList: any[],
  targetArray: any[],
): void {
  if (!Array.isArray(currentList) || !Array.isArray(targetArray)) {
    return
  }

  const isKeyed =
    targetArray.some(item => item != null && typeof item === 'object' && typeof item.id === 'string') ||
    currentList.some(item => item != null && typeof item === 'object' && typeof item.id === 'string')

  if (isKeyed) {
    reconcileKeyedArray(currentList, targetArray)
  } else {
    reconcilePrimitiveArray(currentList, targetArray)
  }
}

/**
 * Applies updates to an Automerge document draft in place.
 * Ensures array fields (notes, members, prayedFor) are reconciled in place
 * on existing Automerge list proxies rather than replaced with new objects.
 */
export function applyItemUpdatesToDraft(
  draft: Record<string, any>,
  updates: Partial<Item>,
): void {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete draft[key]
    } else if (Array.isArray(value)) {
      if (Array.isArray(draft[key])) {
        // Reconcile existing Automerge list proxy in place
        reconcileAutomergeList(draft[key], value)
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
