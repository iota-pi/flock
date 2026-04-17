import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  observeAutomergeKnownItemIds: vi.fn(async () => undefined),
  subscribeKnownAutomergeItemIds: vi.fn(),
}))

vi.mock('./automergeDocStore', () => ({
  observeAutomergeKnownItemIds: mocks.observeAutomergeKnownItemIds,
}))

vi.mock('./automergeRepo', () => ({
  subscribeKnownAutomergeItemIds: mocks.subscribeKnownAutomergeItemIds,
}))

import {
  startAutomergeKnownItemIdsOrchestrator,
  stopAutomergeKnownItemIdsOrchestrator,
} from './automergeKnownItemIdsOrchestrator'

async function flushQueue(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('automergeKnownItemIdsOrchestrator', () => {
  beforeEach(() => {
    stopAutomergeKnownItemIdsOrchestrator()
    vi.clearAllMocks()
  })

  it('subscribes for account and mirrors known IDs to doc store', async () => {
    mocks.subscribeKnownAutomergeItemIds.mockImplementation((listener: (itemIds: string[]) => void) => {
      listener(['doc-1', 'doc-2'])
      return vi.fn()
    })

    startAutomergeKnownItemIdsOrchestrator('acct-1')
    await flushQueue()

    expect(mocks.subscribeKnownAutomergeItemIds).toHaveBeenCalledWith(expect.any(Function), 'acct-1')
    expect(mocks.observeAutomergeKnownItemIds).toHaveBeenCalledWith(['doc-1', 'doc-2'])
  })

  it('does not resubscribe when started with the same account', () => {
    mocks.subscribeKnownAutomergeItemIds.mockImplementation(() => vi.fn())

    startAutomergeKnownItemIdsOrchestrator('acct-1')
    startAutomergeKnownItemIdsOrchestrator('acct-1')

    expect(mocks.subscribeKnownAutomergeItemIds).toHaveBeenCalledTimes(1)
  })

  it('ignores stale account callbacks after account switch', async () => {
    const listeners: Array<(itemIds: string[]) => void> = []

    mocks.subscribeKnownAutomergeItemIds.mockImplementation((listener: (itemIds: string[]) => void) => {
      listeners.push(listener)
      return vi.fn()
    })

    startAutomergeKnownItemIdsOrchestrator('acct-1')
    startAutomergeKnownItemIdsOrchestrator('acct-2')

    listeners[0]?.(['stale-doc'])
    listeners[1]?.(['fresh-doc'])

    await flushQueue()

    expect(mocks.observeAutomergeKnownItemIds).toHaveBeenCalledWith(['fresh-doc'])
    expect(mocks.observeAutomergeKnownItemIds).not.toHaveBeenCalledWith(['stale-doc'])
  })
})
