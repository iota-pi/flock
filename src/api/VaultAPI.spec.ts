import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as api from './VaultAPI'
import * as util from './util'

describe('VaultAPI', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.spyOn(util, 'getAccountId').mockReturnValue('acct1')
  })

  afterEach(() => {
    vi.resetAllMocks()
  })

  it('vaultFetchMany with cacheTime returns items', async () => {
    const expected = [{ item: 'a', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } }]
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, items: expected } as any)

    const result = await api.vaultFetchMany({ cacheTime: 123 })
    expect(result).toEqual(expected)
  })

  it('vaultFetchMany with ids uses flockRequestChunked and flattens results', async () => {
    const r1 = { success: true, items: [{ item: 'a' }] }
    const r2 = { success: true, items: [{ item: 'b' }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([r1, r2] as any)

    const result = await api.vaultFetchMany({ ids: ['1', '2'] })
    expect(result).toEqual([{ item: 'a' }, { item: 'b' }])
  })

  it('vaultFetchMany throws when neither cacheTime nor ids provided', async () => {
    await expect(api.vaultFetchMany({} as any)).rejects.toThrow('Must provide cacheTime or ids')
  })

  it('vaultPut succeeds when api returns success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true } as any)
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).resolves.toBeUndefined()
  })

  it('vaultPut throws when api returns failure', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: false } as any)
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).rejects.toThrow()
  })

  it('vaultPutMany succeeds when all items in all chunks return success', async () => {
    const chunk1 = { success: true, details: [{ item: 'a', success: true }, { item: 'b', success: true }] }
    const chunk2 = { success: true, details: [{ item: 'c', success: true }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([chunk1, chunk2] as any)
    await expect(api.vaultPutMany({ items: [] as any })).resolves.toBeUndefined()
  })

  it('vaultPutMany throws when any item in details fails', async () => {
    const chunk1 = { success: true, details: [{ item: 'a', success: true }, { item: 'b', success: false }] }
    const chunk2 = { success: true, details: [{ item: 'c', success: true }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([chunk1, chunk2] as any)
    await expect(api.vaultPutMany({ items: [] as any })).rejects.toThrow('failed for items: b')
  })

  it('vaultPutMany includes all failed item ids in error message', async () => {
    const chunk1 = { success: true, details: [{ item: 'a', success: false }, { item: 'b', success: false }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([chunk1] as any)
    await expect(api.vaultPutMany({ items: [] as any })).rejects.toThrow('failed for items: a, b')
  })

  it('vaultDelete succeeds when api returns success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true } as any)
    await expect(api.vaultDelete({ item: 'x' })).resolves.toBeUndefined()
  })

  it('vaultDelete throws when api returns failure', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: false } as any)
    await expect(api.vaultDelete({ item: 'x' })).rejects.toThrow()
  })

  it('vaultDeleteMany succeeds when all items in all chunks succeed', async () => {
    const chunk1 = { success: true, details: [{ item: 'a', success: true }] }
    const chunk2 = { success: true, details: [{ item: 'b', success: true }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([chunk1, chunk2] as any)
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] })).resolves.toBeUndefined()
  })

  it('vaultDeleteMany throws when any item in details fails', async () => {
    const chunk1 = { success: true, details: [{ item: 'a', success: true }, { item: 'b', success: false }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([chunk1] as any)
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] })).rejects.toThrow('failed for items: b')
  })

  it('vaultDeleteMany includes all failed item ids in error message', async () => {
    const chunk1 = { success: true, details: [{ item: 'x', success: false }] }
    const chunk2 = { success: true, details: [{ item: 'y', success: false }, { item: 'z', success: true }] }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([chunk1, chunk2] as any)
    await expect(api.vaultDeleteMany({ items: ['x', 'y', 'z'] })).rejects.toThrow('failed for items: x, y')
  })

  it('vaultCreateAccount returns account from response', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ account: 'acct1' } as any)
    const res = await api.vaultCreateAccount({ salt: 's', authToken: 't' } as any)
    expect(res).toEqual({ account: 'acct1' })
  })

  it('vaultGetSalt validates response', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, salt: 'saltx' } as any)
    await expect(api.vaultGetSalt()).resolves.toBe('saltx')

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: false } as any)
    await expect(api.vaultGetSalt()).rejects.toThrow()

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, salt: undefined } as any)
    await expect(api.vaultGetSalt()).rejects.toThrow()
  })

  it('vaultGetSession validates response', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, session: 'sess' } as any)
    await expect(api.vaultGetSession('t')).resolves.toBe('sess')

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: false } as any)
    await expect(api.vaultGetSession('t')).rejects.toThrow()

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, session: undefined } as any)
    await expect(api.vaultGetSession('t')).rejects.toThrow()
  })

  it('vaultGetMetadata returns metadata when present', async () => {
    const meta = { prayerGoal: 1 }
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, metadata: meta } as any)
    const res = await api.vaultGetMetadata()
    expect(res).toEqual(meta)
  })

  it('vaultGetMetadata throws when success is false', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: false } as any)
    await expect(api.vaultGetMetadata()).rejects.toThrow()
  })

  it('vaultSetMetadata succeeds when api returns success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true } as any)
    await api.vaultSetMetadata({ cipher: 'c', iv: 'i' } as any)
  })

  it('vaultSetSubscription and vaultDeleteSubscription succeed when api returns success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true } as any)
    await api.vaultSetSubscription({ subscriptionId: 's', subscription: {} as any } as any)
    await api.vaultDeleteSubscription({ subscriptionId: 's' } as any)
  })

  it('vaultGetSubscription throws on !success and returns subscription on success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: false } as any)
    await expect(api.vaultGetSubscription({ subscriptionId: 's' } as any)).rejects.toThrow()

    const sub = { endpoint: 'e' }
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ success: true, subscription: sub } as any)
    const res = await api.vaultGetSubscription({ subscriptionId: 's' } as any)
    expect(res).toEqual(sub)
  })
})
