import { describe, expect, it, vi } from 'vitest'
import { itemsRouter } from './items'

function createMockContext() {
  const vault = {
    checkSession: vi.fn(async () => ({ success: true })),
    extendSession: vi.fn(async () => undefined),
    setMany: vi.fn(async () => undefined),
    set: vi.fn(async () => undefined),
    fetchAll: vi.fn(async () => []),
    fetchMany: vi.fn(async () => []),
    resolveBranchConflict: vi.fn(async () => undefined),
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
          cipher: 'cipher-1',
          iv: 'iv-1',
          modified: 100,
          type: 'person',
          version: 2,
          deleted: false,
          ttl: 999999,
        } as any,
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const mappedItem = ctx.vault.setMany.mock.calls[0][0][0]
    expect(mappedItem).not.toHaveProperty('ttl')
    expect(mappedItem.metadata.deleted).toBe(false)
  })

  it('deduplicates repeated putMany calls with the same idempotency key', async () => {
    const ctx = createMockContext()
    const caller = itemsRouter.createCaller(ctx as any)

    const payload = {
      account: 'acct-1',
      idempotencyKey: 'stable-idempotency-key',
      items: [
        {
          id: 'item-2',
          cipher: 'cipher-2',
          iv: 'iv-2',
          modified: 200,
          type: 'group',
          version: 1,
          deleted: false,
        },
      ],
    }

    await caller.putMany(payload)
    await caller.putMany(payload)

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
  })
})

describe('itemsRouter: Lineage-Aware Branching', () => {
  it('detects fast-forward when parentIds match current versionId', async () => {
    const ctx = createMockContext()

    // Mock the database to return an existing item with version 'v1'
    (ctx.vault.fetchMany as any).mockResolvedValue([
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
          iv: '',
          modified: 200,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const item = ctx.vault.setMany.mock.calls[0][0][0]
    // _fastForward should be true, so DynamoDB will do a PUT (overwrite)
    expect(item._fastForward).toBe(true)
  })

  it('detects concurrent edit when parentIds do not match current versionId', async () => {
    const ctx = createMockContext()

    // Mock database with version v2
    (ctx.vault.fetchMany as any).mockResolvedValue([
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
          iv: '',
          modified: 150,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const item = ctx.vault.setMany.mock.calls[0][0][0]
    // _fastForward should be false, so DynamoDB will append branch
    expect(item._fastForward).toBe(false)
  })

  it('always fast-forwards legacy cipher format', async () => {
    const ctx = createMockContext()

    (ctx.vault.fetchMany as any).mockResolvedValue([
      {
        item: 'item-1',
        cipher: 'old-cipher',
        metadata: {
          type: 'person',
          iv: 'iv-1',
          modified: 100,
        },
      },
    ])

    const caller = itemsRouter.createCaller(ctx as any)

    await caller.putMany({
      account: 'acct-1',
      items: [
        {
          id: 'item-1',
          cipher: 'new-cipher',
          iv: 'iv-2',
          modified: 200,
          type: 'person',
        },
      ],
    })

    expect(ctx.vault.setMany).toHaveBeenCalledTimes(1)
    const item = ctx.vault.setMany.mock.calls[0][0][0]
    expect(item._fastForward).toBe(true)
  })

  it('idempotency key prevents duplicate branch appends', async () => {
    const ctx = createMockContext()

    (ctx.vault.fetchMany as any).mockResolvedValue([
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
          iv: '',
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
    (ctx.vault.resolveBranchConflict as any) = vi.fn(async () => undefined)

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
    (ctx.vault.resolveBranchConflict as any) = vi.fn(async () => undefined)

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
    (ctx.vault.resolveBranchConflict as any) = vi.fn()
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
    (ctx.vault.resolveBranchConflict as any) = vi.fn(async () => undefined)

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