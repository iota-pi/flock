export type QueueNetworkExecutor = {
  put: (payload: unknown) => Promise<void>
  putMany: (payload: unknown) => Promise<void>
  resolveBranchConflict: (payload: unknown) => Promise<void>
  updateMetadata: (payload: unknown) => Promise<void>
}

let queueNetworkExecutor: QueueNetworkExecutor | null = null

export function initializeQueueNetworkExecutor(executor: QueueNetworkExecutor): void {
  queueNetworkExecutor = executor
}

export function isQueueNetworkExecutorInitialized(): boolean {
  return queueNetworkExecutor !== null
}

export function getQueueNetworkExecutor(): QueueNetworkExecutor {
  if (!queueNetworkExecutor) {
    throw new Error('Queue network executor is not initialized')
  }

  return queueNetworkExecutor
}
