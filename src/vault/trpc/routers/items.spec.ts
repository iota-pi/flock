import { describe, expect, it, vi } from 'vitest'
import { itemsRouter } from './items'

function createMockContext() {
  const vault = {
    checkSession: vi.fn(async () => ({ success: true })),
    extendSession: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    fetchAll: vi.fn(async () => []),
    fetchMany: vi.fn(async () => []),
    fetchHistory: vi.fn(async () => []),
    claimIdempotencyKey: vi.fn(async () => true),
    archiveAndSetManyTransaction: vi.fn(async () => undefined),
    archiveAndReplaceTransaction: vi.fn(async () => undefined),
    setMany: vi.fn(async () => undefined),
    resolveBranchConflict: vi.fn(async () => undefined),
    putHistory: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  }

  return {
    authToken: 'session-token',
    vault,
  }
}

describe('itemsRouter contracts', () => {
  it('fetches item history through endpoint', async () => {
    const ctx = createMockContext()
    const history = [{ item: 'item-4', metadata: { type: 'group', iv: '', modified: 123 } }]
    ctx.vault.fetchHistory.mockResolvedValue(history as any)

    const caller = itemsRouter.createCaller(ctx as any)
    const response = await caller.fetchItemHistory({
      account: 'acct-1',
      itemId: 'item-4',
    })

    expect(response.success).toBe(true)
    expect(response.history).toEqual(history)
  })

  it('putMany archives and writes replacements transactionally', async () => {
    const ctx = createMockContext()
    const existing = {
      account: 'acct-1',
      item: 'item-3',
      branches: [{ encryptedAutomergeDoc: 'old', versionId: 'v1', parentIds: [] }],
      metadata: { type: 'person', iv: '', modified: 111 },
    }
    ctx.vault.fetchMany.mockResolvedValue([existing] as any)

    const caller = itemsRouter.createCaller(ctx as any)
    await caller.putMany({
      account: 'acct-1',
      idempotencyKey: 'k1',
      items: [{
        id: 'item-3',
        branches: [{ encryptedAutomergeDoc: 'new', versionId: 'v2', parentIds: ['v1'] }],
        modified: 222,
        type: 'person',
      }],
    })

    expect(ctx.vault.archiveAndSetManyTransaction).toHaveBeenCalledTimes(1)
    expect(ctx.vault.archiveAndSetManyTransaction).toHaveBeenCalledWith(expect.objectContaining({
      historyEntries: [expect.objectContaining({
        account: 'acct-1',
        itemData: existing,
      })],
      replacements: [expect.objectContaining({
        item: 'item-3',
      })],
    }))
  })

  it('deduplicates repeated putMany calls with same idempotency key', async () => {
    const ctx = createMockContext()
    ctx.vault.claimIdempotencyKey.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const caller = itemsRouter.createCaller(ctx as any)

    const payload = {
      account: 'acct-1',
      idempotencyKey: 'stable-key',
      items: [{
        id: 'item-2',
        branches: [{ encryptedAutomergeDoc: 'doc', versionId: 'v2', parentIds: [] }],
        modified: 200,
        type: 'group',
      }],
    }

    await caller.putMany(payload)
    await caller.putMany(payload)

    expect(ctx.vault.archiveAndSetManyTransaction).toHaveBeenCalledTimes(1)
  })

  it('compacts item using archive-and-replace transaction', async () => {
    const ctx = createMockContext()
    const existing = {
      account: 'acct-1',
      item: 'item-compact',
      branches: [{ encryptedAutomergeDoc: 'old', versionId: 'v-old', parentIds: [] }],
      metadata: { type: 'person', iv: '', modified: 111 },
    }
    ctx.vault.fetchMany.mockResolvedValue([existing] as any)

    const caller = itemsRouter.createCaller(ctx as any)
    await caller.compactItem({
      account: 'acct-1',
      item: 'item-compact',
      baseVersionId: 'v-old',
      compactedBranch: { encryptedAutomergeDoc: 'new', versionId: 'v-new', parentIds: [] },
    })

    expect(ctx.vault.archiveAndReplaceTransaction).toHaveBeenCalledWith(expect.objectContaining({
      history: expect.objectContaining({ itemData: existing }),
      replacement: expect.objectContaining({
        item: 'item-compact',
        metadata: expect.objectContaining({ compactedAt: expect.any(Number) }),
      }),
    }))
  })

  it('rejects stale lineage on put when item was compacted', async () => {
    const ctx = createMockContext()
    ctx.vault.fetchMany.mockResolvedValue([
      {
        item: 'item-1',
        branches: [{ encryptedAutomergeDoc: 'doc-current', versionId: 'v-new', parentIds: [] }],
        metadata: { type: 'person', iv: '', modified: 200, compactedAt: Date.now() },
      },
    ] as any)

    const caller = itemsRouter.createCaller(ctx as any)

    await expect(caller.put({
      account: 'acct-1',
      item: 'item-1',
      branches: [{ encryptedAutomergeDoc: 'doc-offline', versionId: 'v-offline', parentIds: ['v-old'] }],
      modified: 250,
      type: 'person',
    })).rejects.toMatchObject({
      message: 'STALE_COMPACTED_BRANCH',
    })
  })

  it('resolveBranchConflict handles partial failures gracefully', async () => {
    const ctx = createMockContext()
    ctx.vault.fetchMany.mockResolvedValue([
      { item: 'item-1', metadata: { type: 'person', iv: '', modified: 1 }, branches: [] },
      { item: 'item-2', metadata: { type: 'person', iv: '', modified: 1 }, branches: [] },
    ] as any)
    ctx.vault.archiveAndReplaceTransaction
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Item not found'))

    const caller = itemsRouter.createCaller(ctx as any)
    const result = await caller.resolveBranchConflict({
      account: 'acct-1',
      idempotencyKey: 'partial-key',
      resolutions: [
        { item: 'item-1', resolvedBranch: { encryptedAutomergeDoc: 'merged1', versionId: 'vm1', parentIds: ['v1'] } },
        { item: 'item-2', resolvedBranch: { encryptedAutomergeDoc: 'merged2', versionId: 'vm2', parentIds: ['v2'] } },
      ],
    })

    expect(result.success).toBe(false)
    expect(result.resolvedCount).toBe(1)
    if (!result.success) {
      expect(result.failed[0].item).toBe('item-2')
    }
  })
})
