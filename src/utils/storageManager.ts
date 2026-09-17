import { isQuotaError } from './storageQuota'

type QuotaExceededListener = (message: string) => void

const listeners = new Set<QuotaExceededListener>()
let isQuotaExceeded = false
let lastReportedTime = 0
const REPORT_THROTTLE_MS = 10000 // 10 seconds

export function registerQuotaReporter(reporter: QuotaExceededListener): () => void {
  listeners.add(reporter)
  return () => {
    listeners.delete(reporter)
  }
}

function reportQuotaExceeded(): void {
  isQuotaExceeded = true
  const now = Date.now()
  if (now - lastReportedTime < REPORT_THROTTLE_MS) {
    return
  }
  lastReportedTime = now
  const message =
    'Storage quota exceeded. Flock cannot save changes or synchronize, risking data loss. Please free up space and check your connection to sync.'
  for (const listener of listeners) {
    try {
      listener(message)
    } catch (err) {
      console.error('[StorageManager] Error in quota listener:', err)
    }
  }
}

export function resetQuotaExceededStatus(): void {
  isQuotaExceeded = false
  lastReportedTime = 0
}

export function checkQuotaExceeded(): boolean {
  if (isQuotaExceeded) {
    reportQuotaExceeded()
    return true
  }
  return false
}

export type QuotaRecoveryHandler = () => Promise<boolean | number | void>

let quotaRecoveryHandler: QuotaRecoveryHandler | null = null

export function registerQuotaRecoveryHandler(handler: QuotaRecoveryHandler | null): () => void {
  quotaRecoveryHandler = handler
  return () => {
    if (quotaRecoveryHandler === handler) {
      quotaRecoveryHandler = null
    }
  }
}

export function clearQuotaRecoveryHandlerForTesting(): void {
  quotaRecoveryHandler = null
}

export interface RunStorageOperationOptions {
  retryOnQuotaError?: boolean
}

/**
 * Runs a storage operation, intercepts IndexedDB write/quota errors, and reports them centrally.
 * If a QuotaRecoveryHandler is registered, attempts compaction/pruning and retries the operation once.
 */
export async function runStorageOperation<T>(
  operation: () => Promise<T>,
  options?: RunStorageOperationOptions
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isQuotaError(error)) {
      if (options?.retryOnQuotaError !== false && quotaRecoveryHandler) {
        try {
          await quotaRecoveryHandler()
          // Retry once after recovery/compaction attempt
          return await operation()
        } catch (retryError) {
          if (isQuotaError(retryError)) {
            reportQuotaExceeded()
          }
          throw retryError
        }
      }
      reportQuotaExceeded()
    }
    throw error
  }
}
