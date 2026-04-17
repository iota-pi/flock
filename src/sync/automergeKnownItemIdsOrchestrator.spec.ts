import { describe, expect, it } from 'vitest'
import {
  startAutomergeKnownItemIdsOrchestrator,
  stopAutomergeKnownItemIdsOrchestrator,
} from './automergeKnownItemIdsOrchestrator'

describe('automergeKnownItemIdsOrchestrator', () => {
  it('is a no-op when started', () => {
    expect(() => startAutomergeKnownItemIdsOrchestrator('acct-1')).not.toThrow()
  })

  it('is a no-op when stopped', () => {
    expect(() => stopAutomergeKnownItemIdsOrchestrator()).not.toThrow()
  })
})