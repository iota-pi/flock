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
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { items: expected } } as any)

    const result = await api.vaultFetchMany({ cacheTime: 123 })
    expect(result).toEqual(expected)
  })

  it('vaultFetchMany with ids uses flockRequestChunked and flattens results', async () => {
    const r1 = { data: { items: [{ item: 'a' }] } }
    const r2 = { data: { items: [{ item: 'b' }] } }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([r1, r2] as any)

    const result = await api.vaultFetchMany({ ids: ['1', '2'] })
    expect(result).toEqual([{ item: 'a' }, { item: 'b' }])
  })

  it('vaultFetchMany throws when neither cacheTime nor ids provided', async () => {
    await expect(api.vaultFetchMany({} as any)).rejects.toThrow('Must provide cacheTime or ids')
  })

  it('vaultFetch returns first item', async () => {
    const item = { item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } }
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { items: [item] } } as any)
    const res = await api.vaultFetch({ item: 'x' })
    expect(res).toEqual(item)
  })

  it('vaultPut succeeds when api returns success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true } } as any)
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).resolves.toBeUndefined()
  })

  it('vaultPut throws when api returns failure', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: false } } as any)
    await expect(api.vaultPut({ item: 'x', cipher: 'c', metadata: { iv: 'i', type: 'person', modified: 1 } } as any)).rejects.toThrow()
  })

  it('vaultPutMany succeeds when all chunks return success', async () => {
    const ok = { data: { success: true } }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([ok, ok] as any)
    await expect(api.vaultPutMany({ items: [] as any })).resolves.toBeUndefined()
  })

  it('vaultPutMany throws when any chunk fails', async () => {
    const ok = { data: { success: true } }
    const bad = { data: { success: false } }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([ok, bad] as any)
    await expect(api.vaultPutMany({ items: [] as any })).rejects.toThrow()
  })

  it('vaultDelete succeeds when api returns success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true } } as any)
    await expect(api.vaultDelete({ item: 'x' })).resolves.toBeUndefined()
  })

  it('vaultDelete throws when api returns failure', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: false } } as any)
    await expect(api.vaultDelete({ item: 'x' })).rejects.toThrow()
  })

  it('vaultDeleteMany succeeds when all chunks succeed', async () => {
    const ok = { data: { success: true } }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([ok, ok] as any)
    await expect(api.vaultDeleteMany({ items: ['a', 'b'] } as any)).resolves.toBeUndefined()
  })

  it('vaultDeleteMany throws when a chunk fails', async () => {
    const ok = { data: { success: true } }
    const bad = { data: { success: false } }
    vi.spyOn(util, 'flockRequestChunked').mockResolvedValue([ok, bad] as any)
    await expect(api.vaultDeleteMany({ items: ['a'] } as any)).rejects.toThrow()
  })

  it('vaultCreateAccount returns account from response', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { account: 'acct1' } } as any)
    const res = await api.vaultCreateAccount({ salt: 's', authToken: 't' } as any)
    expect(res).toEqual({ account: 'acct1' })
  })

  it('vaultGetSalt validates response', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true, salt: 'saltx' } } as any)
    await expect(api.vaultGetSalt()).resolves.toBe('saltx')

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: false } } as any)
    await expect(api.vaultGetSalt()).rejects.toThrow()

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true, salt: 123 } } as any)
    await expect(api.vaultGetSalt()).rejects.toThrow()
  })

  it('vaultGetSession validates response', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true, session: 'sess' } } as any)
    await expect(api.vaultGetSession('t')).resolves.toBe('sess')

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: false } } as any)
    await expect(api.vaultGetSession('t')).rejects.toThrow()

    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true, session: 123 } } as any)
    await expect(api.vaultGetSession('t')).rejects.toThrow()
  })

  it('vaultGetMetadata returns metadata when present', async () => {
    const meta = { prayerGoal: 1 }
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { metadata: meta } } as any)
    const res = await api.vaultGetMetadata()
    expect(res).toEqual(meta)
  })

  it('vaultGetMetadata throws when no metadata', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: {} } as any)
    await expect(api.vaultGetMetadata()).rejects.toThrow()
  })

  it('vaultSetMetadata returns boolean success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true } } as any)
    await api.vaultSetMetadata({ cipher: 'c', iv: 'i' } as any)
  })

  it('vaultSetSubscription and vaultDeleteSubscription return booleans', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true } } as any)
    await api.vaultSetSubscription({ subscriptionId: 's', subscription: {} as any } as any)
    await api.vaultDeleteSubscription({ subscriptionId: 's' } as any)
  })

  it('vaultGetSubscription throws on !success and returns subscription on success', async () => {
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: false } } as any)
    await expect(api.vaultGetSubscription({ subscriptionId: 's' } as any)).rejects.toThrow()

    const sub = { endpoint: 'e' }
    vi.spyOn(util, 'flockRequest').mockResolvedValue({ data: { success: true, subscription: sub } } as any)
    const res = await api.vaultGetSubscription({ subscriptionId: 's' } as any)
    expect(res).toEqual(sub)
  })
})
