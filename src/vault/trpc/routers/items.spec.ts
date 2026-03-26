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