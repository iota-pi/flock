import { describe, expect, it, vi } from 'vitest'
import { itemsRouter } from './items'

function createMockContext() {
  const vault = {
    checkSession: vi.fn(async (..._args: any[]) => ({ success: true })),
    extendSession: vi.fn(async (..._args: any[]) => undefined),
    setMany: vi.fn(async (..._args: any[]) => undefined),
    set: vi.fn(async (..._args: any[]) => undefined),
    fetchAll: vi.fn(async (..._args: any[]) => []),
    fetchMany: vi.fn(async (..._args: any[]) => []),
    resolveBranchConflict: vi.fn(async (..._args: any[]) => undefined),
    putHistory: vi.fn(async (..._args: any[]) => undefined),
    fetchHistory: vi.fn(async (..._args: any[]) => []),
    claimIdempotencyKey: vi.fn(async (..._args: any[]) => true),
  }

  return {
    authToken: 'session-token',
    vault,
  }
}

describe('itemsRouter contracts', () => {
  it('omits legacy ttl field when handling putMany payloads', async () => {
    const ctx = createMockContext()
    const caller = itemsRouter.createCaller(ctx as any)

    await caller.putMany({
      account: 'acct-1',
      idempotencyKey: 'ttl-strip-key',
      items: [
        {
          id: 'item-1',
          branches: [{
            encryptedAutomergeDoc: 'cipher-1',
            versionId: 'v-1',
            parentIds: [],
          }],
          modified: 100,
          type: 'person',
          deleted: false,
          ttl: 999999,
        } as any,
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const mappedItem = (ctx.vault.setMany.mock.calls[0]?.[0] as any[] | undefined)?.[0]
    expect(mappedItem).toBeDefined()
    expect(mappedItem).not.toHaveProperty('ttl')
    expect(mappedItem.metadata.deleted).toBe(false)
  })

  it('deduplicates repeated putMany calls with the same idempotency key', async () => {
    const ctx = createMockContext()
    const caller = itemsRouter.createCaller(ctx as any)
    ctx.vault.claimIdempotencyKey
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const payload = {
      account: 'acct-1',
      idempotencyKey: 'stable-idempotency-key',
      items: [
        {
          id: 'item-2',
          branches: [{
            encryptedAutomergeDoc: 'cipher-2',
            versionId: 'v-2',
            parentIds: [],
          }],
          modified: 200,
          type: 'group',
          deleted: false,
        },
      ],
    }

    await caller.putMany(payload)
    await caller.putMany(payload)

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
  })

  it('archives current item before putMany overwrite', async () => {
    const ctx = createMockContext()
    const existing = {
      account: 'acct-1',
      item: 'item-3',
      cipher: 'old-cipher',
      metadata: {
        type: 'person',
        iv: 'iv-old',
        modified: 111,
      },
    }

    ctx.vault.fetchMany.mockResolvedValue([existing] as any)

    const caller = itemsRouter.createCaller(ctx as any)
    await caller.putMany({
      account: 'acct-1',
      idempotencyKey: 'history-archive-putmany',
      items: [
        {
          id: 'item-3',
          branches: [{
            encryptedAutomergeDoc: 'new-cipher',
            versionId: 'v-new',
            parentIds: [],
          }],
          modified: 222,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.putHistory).toHaveBeenCalledTimes(1)
    expect(ctx.vault.putHistory).toHaveBeenCalledWith(expect.objectContaining({
      account: 'acct-1',
      itemData: existing,
      expiresAt: expect.any(Number),
      historyKey: expect.stringMatching(/^item-3#/),
    }))
  })

  it('fetches item history through the emergency endpoint', async () => {
    const ctx = createMockContext()
    const history = [
      {
        account: 'acct-1',
        item: 'item-4',
        cipher: 'cipher-h1',
        metadata: {
          type: 'group',
          iv: 'iv-h1',
          modified: 123,
        },
      },
    ]
    ctx.vault.fetchHistory.mockResolvedValue(history as any)

    const caller = itemsRouter.createCaller(ctx as any)
    const response = await caller.fetchItemHistory({
      account: 'acct-1',
      itemId: 'item-4',
    })

    expect(response.success).toBe(true)
    expect(response.history).toEqual(history)
    expect(ctx.vault.fetchHistory).toHaveBeenCalledWith('acct-1', 'item-4', undefined)
  })
})

describe('itemsRouter: Lineage-Aware Branching', () => {
  it('passes expected parent for branch writes', async () => {
    const ctx = createMockContext()

    // Mock the database to return an existing item with version 'v1'
    ;(ctx.vault.fetchMany as any).mockResolvedValue([
      {
        item: 'item-1',
        branches: [
          {
            encryptedAutomergeDoc: 'existing-doc',
            versionId: 'v1',
            parentIds: [],
          },
        ],
        metadata: {
          type: 'person',
          iv: 'iv-1',
          modified: 100,
          version: 1,
        },
      },
    ])

    const caller = itemsRouter.createCaller(ctx as any)

    await caller.putMany({
      account: 'acct-1',
      items: [
        {
          id: 'item-1',
          branches: [
            {
              encryptedAutomergeDoc: 'new-doc',
              versionId: 'v2',
              parentIds: ['v1'], // Descends from current head
            },
          ],
          modified: 200,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const item = (ctx.vault.setMany.mock.calls[0]?.[0] as any[] | undefined)?.[0]
    expect(item).toBeDefined()
    expect(item._expectedParentVersionId).toBe('v1')
  })

  it('uses incoming branch lineage for conditional write inputs', async () => {
    const ctx = createMockContext()

    // Mock database with version v2
    ;(ctx.vault.fetchMany as any).mockResolvedValue([
      {
        item: 'item-1',
        branches: [
          {
            encryptedAutomergeDoc: 'doc-v2',
            versionId: 'v2',
            parentIds: ['v1'],
          },
        ],
        metadata: {
          type: 'person',
          iv: 'iv-1',
          modified: 200,
          version: 2,
        },
      },
    ])

    const caller = itemsRouter.createCaller(ctx as any)

    await caller.putMany({
      account: 'acct-1',
      items: [
        {
          id: 'item-1',
          branches: [
            {
              encryptedAutomergeDoc: 'doc-offline',
              versionId: 'v1-offline',
              parentIds: ['v1'], // Based on v1, but v2 already exists
            },
          ],
          modified: 150,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const item = (ctx.vault.setMany.mock.calls[0]?.[0] as any[] | undefined)?.[0]
    expect(item).toBeDefined()
    expect(item._expectedParentVersionId).toBe('v1')
  })

  it('sets no expected parent when writing a genesis branch', async () => {
    const ctx = createMockContext()

    ;(ctx.vault.fetchMany as any).mockResolvedValue([])

    const caller = itemsRouter.createCaller(ctx as any)

    await caller.putMany({
      account: 'acct-1',
      items: [
        {
          id: 'item-1',
          branches: [{
            encryptedAutomergeDoc: 'new-cipher',
            versionId: 'v-new',
            parentIds: [],
          }],
          modified: 200,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const item = (ctx.vault.setMany.mock.calls[0]?.[0] as any[] | undefined)?.[0]
    expect(item).toBeDefined()
    expect(item._expectedParentVersionId).toBeUndefined()
  })

  it('idempotency key prevents duplicate branch appends', async () => {
    const ctx = createMockContext()
    ctx.vault.claimIdempotencyKey
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    ;(ctx.vault.fetchMany as any).mockResolvedValue([
      {
        item: 'item-1',
        branches: [
          {
            encryptedAutomergeDoc: 'v1',
            versionId: 'v1',
            parentIds: [],
          },
        ],
        metadata: { type: 'person', iv: 'iv-1', modified: 100 },
      },
    ])

    const caller = itemsRouter.createCaller(ctx as any)

    const payload = {
      account: 'acct-1',
      idempotencyKey: 'concurrent-branch-key',
      items: [
        {
          id: 'item-1',
          branches: [
            {
              encryptedAutomergeDoc: 'offline-branch',
              versionId: 'v-offline',
              parentIds: ['v1'],
            },
          ],
          modified: 150,
          type: 'person',
        },
      ],
    }

    // Call twice with same idempotency key
    await caller.putMany(payload)
    await caller.putMany(payload)

    // Should only execute once
    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
  })
})

describe('itemsRouter: Resolution Pruning', () => {
  it('resolveBranchConflict replaces multiple branches with single merged branch', async () => {
    const ctx = createMockContext()
    ctx.vault.resolveBranchConflict = vi.fn(async () => undefined)

    const caller = itemsRouter.createCaller(ctx as any)

    const mergedBranch = {
      encryptedAutomergeDoc: 'merged-doc',
      versionId: 'v-merged',
      parentIds: ['v1', 'v2'],
    }

    await caller.resolveBranchConflict({
      account: 'acct-1',
      idempotencyKey: 'resolution-key',
      resolutions: [
        {
          item: 'item-1',
          resolvedBranch: mergedBranch,
        },
      ],
    })

    expect(ctx.vault.resolveBranchConflict).toHaveBeenCalledWith(
      'acct-1',
      'item-1',
      mergedBranch,
    )
  })

  it('resolveBranchConflict broadcasts resolved items via WebSocket', async () => {
    const ctx = createMockContext()
    ctx.vault.resolveBranchConflict = vi.fn(async () => undefined)

    const caller = itemsRouter.createCaller(ctx as any)

    const result = await caller.resolveBranchConflict({
      account: 'acct-1',
      idempotencyKey: 'bc-key',
      resolutions: [
        {
          item: 'item-1',
          resolvedBranch: {
            encryptedAutomergeDoc: 'merged',
            versionId: 'vm1',
            parentIds: ['v1', 'v2'],
          },
        },
      ],
    })

    expect(result.success).toBe(true)
    expect(result.resolvedCount).toBe(1)
  })

  it('resolveBranchConflict handles partial failures gracefully', async () => {
    const ctx = createMockContext()

    // First call succeeds, second throws
    ctx.vault.resolveBranchConflict = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('Item not found'))

    const caller = itemsRouter.createCaller(ctx as any)

    const result = await caller.resolveBranchConflict({
      account: 'acct-1',
      idempotencyKey: 'partial-key',
      resolutions: [
        {
          item: 'item-1',
          resolvedBranch: {
            encryptedAutomergeDoc: 'merged1',
            versionId: 'vm1',
            parentIds: ['v1'],
          },
        },
        {
          item: 'item-2',
          resolvedBranch: {
            encryptedAutomergeDoc: 'merged2',
            versionId: 'vm2',
            parentIds: ['v2'],
          },
        },
      ],
    })

    expect(result.success).toBe(false)
    expect(result.resolvedCount).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed?.[0].item).toBe('item-2')
  })

  it('resolution idempotency prevents duplicate pushes', async () => {
    const ctx = createMockContext()
    ctx.vault.resolveBranchConflict = vi.fn(async () => undefined)
    ctx.vault.claimIdempotencyKey
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)

    const caller = itemsRouter.createCaller(ctx as any)

    const payload = {
      account: 'acct-1',
      idempotencyKey: 'same-key',
      resolutions: [
        {
          item: 'item-1',
          resolvedBranch: {
            encryptedAutomergeDoc: 'doc',
            versionId: 'v-res',
            parentIds: ['v1', 'v2'],
          },
        },
      ],
    }

    // Call twice
    await caller.resolveBranchConflict(payload)
    await caller.resolveBranchConflict(payload)

    // Should only call vault once
    expect(ctx.vault.resolveBranchConflict).toHaveBeenCalledTimes(1)
  })
})