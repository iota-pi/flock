import { observeAutomergeKnownItemIds } from './automergeDocStore'
import { subscribeKnownAutomergeItemIds } from './automergeRepo'

let activeAccount: string | null = null
let unsubscribeKnownItemIds: (() => void) | null = null
let knownItemIdsQueue: Promise<void> = Promise.resolve()
let observerGeneration = 0

function normalizeAccount(account: string): string | null {
  if (typeof account !== 'string') {
    return null
  }

  const trimmedAccount = account.trim()
  return trimmedAccount.length > 0 ? trimmedAccount : null
}

function clearKnownItemIdsSubscription(): void {
  if (!unsubscribeKnownItemIds) {
    return
  }

  unsubscribeKnownItemIds()
  unsubscribeKnownItemIds = null
}

function enqueueKnownItemIdsObservation(itemIds: string[], generation: number): void {
  const snapshot = Array.isArray(itemIds) ? [...itemIds] : []

  knownItemIdsQueue = knownItemIdsQueue
    .then(async () => {
      if (generation !== observerGeneration) {
        return
      }

      await observeAutomergeKnownItemIds(snapshot)
    })
    .catch((error: unknown) => {
      if (generation !== observerGeneration) {
        return
      }

      console.error('[automergeKnownItemIdsOrchestrator] failed to observe known item ids', error)
    })
}

export function startAutomergeKnownItemIdsOrchestrator(account: string): void {
  const normalizedAccount = normalizeAccount(account)
  if (!normalizedAccount) {
    stopAutomergeKnownItemIdsOrchestrator()
    return
  }

  if (activeAccount === normalizedAccount && unsubscribeKnownItemIds) {
    return
  }

  clearKnownItemIdsSubscription()
  activeAccount = normalizedAccount

  observerGeneration += 1
  const generation = observerGeneration

  unsubscribeKnownItemIds = subscribeKnownAutomergeItemIds(
    itemIds => {
      enqueueKnownItemIdsObservation(itemIds, generation)
    },
    normalizedAccount,
  )
}

export function stopAutomergeKnownItemIdsOrchestrator(): void {
  clearKnownItemIdsSubscription()
  activeAccount = null
  observerGeneration += 1
  knownItemIdsQueue = Promise.resolve()
}
