import type { VaultEnvelope } from '../../vault/types'

function hashText(input: string): string {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }

  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function getEnvelopeCacheKey(envelope: VaultEnvelope): string {
  if (envelope.kind === 'legacy') {
    return `cipher-hash-v1:${hashText(envelope.cipher)}`
  }

  const headVersionId = envelope.branches[0]?.versionId || 'none'
  return `branch-head-v1:${headVersionId}`
}
