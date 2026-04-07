import { describe, expect, it, vi } from 'vitest'
import { itemsRouter } from './items'

function createMockContext() {
  const vault = {
    checkSession: vi.fn(async () => ({ success: true })),
    extendSession: vi.fn(async () => undefined),
    fetchAll: vi.fn(async () => []),
    fetchMany: vi.fn(async () => []),
  }

  return {
    authToken: 'session-token',
    vault,
  }
}

describe('itemsRouter contracts', () => {
  it('filters deleted items for non-cache fetches', async () => {
    const ctx = createMockContext()
    ctx.vault.fetchAll.mockResolvedValue([
      { item: 'a', metadata: { deleted: false } },
      { item: 'b', metadata: { deleted: true } },
    ] as any)

    const caller = itemsRouter.createCaller(ctx as any)
    const response = await caller.fetchMany({ account: 'acct-1', cacheTime: null })

    expect(response.success).toBe(true)
    expect(response.items).toHaveLength(1)
    expect(response.items[0].item).toBe('a')
  })

  it('includes deleted items for cache-time delta fetches', async () => {
    const ctx = createMockContext()
    ctx.vault.fetchAll.mockResolvedValue([
      { item: 'a', metadata: { deleted: false } },
      { item: 'b', metadata: { deleted: true } },
    ] as any)

    const caller = itemsRouter.createCaller(ctx as any)
    const response = await caller.fetchMany({ account: 'acct-1', cacheTime: Date.now() })

    expect(response.success).toBe(true)
    expect(response.items).toHaveLength(2)
  })
})
