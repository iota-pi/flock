import type { VaultBranch } from '../shared/itemTypes'

export type ItemType = 'person' | 'group' | 'topic'

export type LegacyEnvelope = {
  kind: 'legacy'
  cipher: string
  iv: string
}

export type BranchingEnvelope = {
  kind: 'branching'
  branches: VaultBranch[]
}

export type VaultEnvelope = LegacyEnvelope | BranchingEnvelope

export type WebPushSubscription = {
  endpoint: string,
  keys: {
    p256dh: string,
    auth: string,
  },
}