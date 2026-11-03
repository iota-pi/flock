import * as Automerge from '@automerge/automerge/slim'

export type AutomergeListItem = { id?: string; [key: string]: unknown }

/**
 * Where an object sits in the Automerge doc being changed, so string fields can be edited with
 * `Automerge.updateText`. Absent for plain objects outside a change.
 */
export type DocLocation = { root: Automerge.Doc<unknown>; path: Automerge.Prop[] }

function childLocation(at: DocLocation | undefined, key: Automerge.Prop): DocLocation | undefined {
  return at && { root: at.root, path: [...at.path, key] }
}

function rootLocation(draft: Record<string, unknown>): DocLocation | undefined {
  return Automerge.isAutomerge(draft) ? { root: draft, path: [] } : undefined
}

/**
 * Writes one field, skipping unchanged values. Every write is a new op that beats concurrent edits from
 * other devices, and assigning a string replaces its Text object, so a whole-item save would otherwise
 * undo remote edits to fields it didn't change. Changed strings are diffed into the existing Text object.
 */
function setField(obj: Record<string, unknown>, key: string, value: unknown, at: DocLocation | undefined): void {
  const current = obj[key]
  if (current === value) return
  if (value === undefined) {
    if (key in obj) delete obj[key]
  } else if (Array.isArray(value) && Array.isArray(current)) {
    reconcileAutomergeList(current, value, childLocation(at, key))
  } else if (at && typeof value === 'string' && typeof current === 'string') {
    Automerge.updateText(at.root, [...at.path, key], value)
  } else {
    obj[key] = value
  }
}

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
  at?: DocLocation,
): void {
  for (const [key, value] of Object.entries(targetObj)) {
    setField(existingObj, key, value, at)
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
  at?: DocLocation,
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
      updateObjectInPlace(curr as Record<string, unknown>, tgt as Record<string, unknown>, childLocation(at, prefix))
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
      updateObjectInPlace(
        curr as Record<string, unknown>,
        tgt as Record<string, unknown>,
        childLocation(at, currentSuffix),
      )
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
        updateObjectInPlace(curr as Record<string, unknown>, tgt as Record<string, unknown>, childLocation(at, prefix))
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

  // For kept items in the middle, update properties in place on the object proxy (before any splice moves them)
  for (const op of ops) {
    if (op.type === 'keep') {
      const curr = currentMiddle[op.oldIdx]
      const tgt = incomingMiddle[op.newIdx]
      if (curr != null && typeof curr === 'object' && tgt != null && typeof tgt === 'object') {
        updateObjectInPlace(
          curr as Record<string, unknown>,
          tgt as Record<string, unknown>,
          childLocation(at, prefix + op.oldIdx),
        )
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
 * Unchanged fields are left alone, lists are reconciled on their existing proxies and changed strings are
 * diffed into their Text objects, so concurrent edits to other fields (or other parts of a string) survive.
 */
export function applyItemUpdatesToDraft(
  draft: Record<string, unknown>,
  updates: Record<string, unknown>,
): void {
  const at = rootLocation(draft)
  for (const [key, value] of Object.entries(updates)) {
    setField(draft, key, value, at)
  }
}

/** Makes a draft match a snapshot, dropping the fields it lacks and writing only the ones that differ */
export function mutateDraftToMatchSnapshot(
  draft: Record<string, unknown>,
  snapshot: Record<string, unknown>,
): void {
  for (const key of Object.keys(draft)) {
    if (!(key in snapshot) || snapshot[key] === undefined) {
      delete draft[key]
    }
  }
  applyItemUpdatesToDraft(draft, snapshot)
}
