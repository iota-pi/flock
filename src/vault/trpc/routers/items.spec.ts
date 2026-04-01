import { describe, expect, it, vi } from 'vitest'
import { itemsRouter } from './items'
import { TransactionConflictsError } from '../../drivers/dynamo'

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
    ctx.vault.fetchHistory.mockResolvedValue({ history, nextCursor: null } as any)

    const caller = itemsRouter.createCaller(ctx as any)
    const response = await caller.fetchItemHistory({
      account: 'acct-1',
      itemId: 'item-4',
    })

    expect(response.success).toBe(true)
    expect(response.history).toEqual(history)
    expect(response.nextCursor).toBe(null)
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

  it('passes transactional idempotency context for putMany writes', async () => {
    const ctx = createMockContext()
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

    expect(ctx.vault.archiveAndSetManyTransaction).toHaveBeenCalledTimes(1)
    expect(ctx.vault.archiveAndSetManyTransaction).toHaveBeenCalledWith(expect.objectContaining({
      idempotency: expect.objectContaining({
        account: 'acct-1',
        idempotencyKey: 'stable-key',
      }),
    }))
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

  it('resolveBranchConflict handles transaction conflicts gracefully', async () => {
    const ctx = createMockContext()
    ctx.vault.fetchMany.mockResolvedValue([
      { item: 'item-1', metadata: { type: 'person', iv: '', modified: 1 }, branches: [] },
      { item: 'item-2', metadata: { type: 'person', iv: '', modified: 1 }, branches: [] },
    ] as any)
    ctx.vault.archiveAndSetManyTransaction
      .mockRejectedValueOnce(new TransactionConflictsError(['item-2']))

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

  it('resolveBranchConflict passes transactional idempotency context', async () => {
    const ctx = createMockContext()
    const caller = itemsRouter.createCaller(ctx as any)

    await caller.resolveBranchConflict({
      account: 'acct-1',
      idempotencyKey: 'resolve-key',
      resolutions: [
        { item: 'item-1', resolvedBranch: { encryptedAutomergeDoc: 'merged1', versionId: 'vm1', parentIds: ['v1'] } },
      ],
    })

    expect(ctx.vault.archiveAndSetManyTransaction).toHaveBeenCalledWith(expect.objectContaining({
      idempotency: expect.objectContaining({
        account: 'acct-1',
        idempotencyKey: 'resolve-key',
      }),
    }))
  })
})
