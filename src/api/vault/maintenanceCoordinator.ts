import type { VaultItem } from './client'
import { getVaultKey } from '../vault'
import { maybeCompactItemInWorker } from '../../workers/decryptionWorkerManager'
import { getEnvelopeCacheKey } from './decryptionCacheKey'
import { sharedDecryptionCache } from './DecryptionCache'
import type { VaultEnvelope } from '../../vault/types'

type CompactionCandidate = {
  source: VaultItem
  automergeBinary: Uint8Array
}

const queue: CompactionCandidate[] = []
const queuedKeys = new Set<string>()
let isProcessing = false
let processTimer: ReturnType<typeof setTimeout> | null = null

function getCandidateKey(candidate: CompactionCandidate): string | null {
  const itemId = candidate.source.item
  const headVersionId = candidate.source.branches?.[0]?.versionId
  if (!itemId || !headVersionId) {
    return null
  }

  return `${itemId}:${headVersionId}`
}

async function processQueue(): Promise<void> {
  if (isProcessing) {
    return
  }

  isProcessing = true
  try {
    while (queue.length > 0) {
      const candidate = queue.shift()
      if (!candidate) {
        continue
      }

      const queueKey = getCandidateKey(candidate)
      if (queueKey) {
        queuedKeys.delete(queueKey)
      }

      try {
        await maybeCompactItemInWorker({
          key: getVaultKey(),
          source: candidate.source,
          automergeBinary: candidate.automergeBinary,
          onCompacted: async compacted => {
            const compactedEnvelope: VaultEnvelope = {
              kind: 'branching',
              branches: [compacted.compactedBranch],
            }
            const cached = sharedDecryptionCache.get(compacted.itemId)
            if (!cached) {
              return
            }

            sharedDecryptionCache.set(compacted.itemId, {
              ...cached,
              cacheKey: getEnvelopeCacheKey(compactedEnvelope),
              automergeBinary: compacted.compactedBinary,
            })
            sharedDecryptionCache.schedulePersist(candidate.source.account || '')
          },
          onError: error => {
            const itemId = candidate.source.item
            console.warn(`[Compaction] background processing failed for item ${itemId}`, error)
          },
        })
      } catch (error) {
        const itemId = candidate.source.item
        console.warn(`[Compaction] background processing failed for item ${itemId}`, error)
      }
    }
  } finally {
    isProcessing = false
  }
}

export function enqueueCompactionCandidate(candidate: CompactionCandidate): void {
  const queueKey = getCandidateKey(candidate)
  if (queueKey && queuedKeys.has(queueKey)) {
    return
  }

  if (queueKey) {
    queuedKeys.add(queueKey)
  }

  queue.push(candidate)

  if (processTimer) {
    clearTimeout(processTimer)
  }

  processTimer = setTimeout(() => {
    processTimer = null
    void processQueue()
  }, 200)
}