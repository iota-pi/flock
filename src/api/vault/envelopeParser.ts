import type { VaultBranch } from '../../shared/itemTypes'
import type { VaultEnvelope } from '../../vault/types'

function isBranch(value: unknown): value is VaultBranch {
  if (!value || typeof value !== 'object') {
    return false
  }

  const branch = value as Partial<VaultBranch>
  return (
    typeof branch.encryptedAutomergeDoc === 'string'
    && typeof branch.versionId === 'string'
    && Array.isArray(branch.parentIds)
    && branch.parentIds.every(parentId => typeof parentId === 'string')
  )
}

export function parseVaultEnvelope(payload: unknown): VaultEnvelope | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const candidate = payload as {
    cipher?: unknown
    iv?: unknown
    branches?: unknown
    metadata?: {
      iv?: unknown
    }
  }

  if (
    Array.isArray(candidate.branches)
    && candidate.branches.length > 0
    && candidate.branches.every(isBranch)
  ) {
    return {
      kind: 'branching',
      branches: candidate.branches,
    }
  }

  const iv = typeof candidate.iv === 'string'
    ? candidate.iv
    : (typeof candidate.metadata?.iv === 'string' ? candidate.metadata.iv : null)

  if (typeof candidate.cipher === 'string' && typeof iv === 'string') {
    return {
      kind: 'legacy',
      cipher: candidate.cipher,
      iv,
    }
  }

  return null
}