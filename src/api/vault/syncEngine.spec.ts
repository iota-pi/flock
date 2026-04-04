import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { itemsSyncEngine } from './syncEngine'
import { syncDB } from '../db'
import * as serverTimeStore from '../../sync/syncServerTimeStore'

vi.mock('../db', () => ({
  syncDB: {
    getItem: vi.fn(),
    setItem: vi.fn(),
  },
}))

vi.mock('../../sync/syncServerTimeStore', () => ({
  getLastSyncServerTime: vi.fn(),
}))

describe('ItemsSyncEngine', () => {
  beforeEach(() => {
    itemsSyncEngine.reset()
    vi.clearAllMocks()
  })

  afterEach(() => {
    itemsSyncEngine.reset()
  })

  it('performs a full fetch when local state is empty', async () => {
    vi.mocked(syncDB.getItem).mockResolvedValue(null)
    vi.mocked(serverTimeStore.getLastSyncServerTime).mockReturnValue(1000)

    const fetchDeltaMock = vi.fn().mockResolvedValue({
      items: [{ item: 'item-1', metadata: { deleted: false } }],
      serverTime: 2000,
    })
    const decryptMock = vi.fn().mockResolvedValue([
      { id: 'item-1', type: 'person', name: 'Decrypted item', archived: false },
    ])
    const migrateMock = vi.fn().mockResolvedValue([])

    const result = await itemsSyncEngine.pull({
      accountId: 'acct-1',
      metadata: {},
      fetchDelta: fetchDeltaMock,
      decryptItems: decryptMock,
      migrateItems: migrateMock,
    })

    expect(fetchDeltaMock).toHaveBeenCalledWith(null)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ id: 'item-1', name: 'Decrypted item' })
    expect(syncDB.setItem).toHaveBeenCalledWith('items-sync-engine_acct-1', { items: result })
  })

  it('performs delta merge when local state exists', async () => {
    const existingItems = [
      { id: 'item-1', type: 'person', name: 'Old Name', archived: false },
    ]

    vi.mocked(syncDB.getItem).mockResolvedValue({ items: existingItems })
    vi.mocked(serverTimeStore.getLastSyncServerTime).mockReturnValue(5000)

    const fetchDeltaMock = vi.fn().mockResolvedValue({
      items: [
        { item: 'item-1', metadata: { deleted: false } },
        { item: 'item-2', metadata: { deleted: false } },
      ],
      serverTime: 6000,
    })
    const decryptMock = vi.fn().mockResolvedValue([
      { id: 'item-1', type: 'person', name: 'New Name', archived: false },
      { id: 'item-2', type: 'person', name: 'Brand New', archived: false },
    ])
    const migrateMock = vi.fn().mockResolvedValue([])

    const result = await itemsSyncEngine.pull({
      accountId: 'acct-1',
      metadata: {},
      fetchDelta: fetchDeltaMock,
      decryptItems: decryptMock,
      migrateItems: migrateMock,
    })

    expect(fetchDeltaMock).toHaveBeenCalledWith(5000)
    expect(result).toHaveLength(2)
    expect(result.find(item => item.id === 'item-1')?.name).toBe('New Name')
    expect(result.find(item => item.id === 'item-2')?.name).toBe('Brand New')
  })

  it('removes deleted ids during delta merge', async () => {
    const existingItems = [
      { id: 'item-1', type: 'person', name: 'Keep Me', archived: false },
      { id: 'item-2', type: 'person', name: 'Delete Me', archived: false },
    ]

    vi.mocked(syncDB.getItem).mockResolvedValue({ items: existingItems })
    vi.mocked(serverTimeStore.getLastSyncServerTime).mockReturnValue(5000)

    const fetchDeltaMock = vi.fn().mockResolvedValue({
      items: [{ item: 'item-2', metadata: { deleted: true } }],
      serverTime: 6000,
    })
    const decryptMock = vi.fn().mockResolvedValue([
      { id: 'item-2', type: 'person', name: 'Delete Me', archived: false },
    ])
    const migrateMock = vi.fn().mockResolvedValue([])

    const result = await itemsSyncEngine.pull({
      accountId: 'acct-1',
      metadata: {},
      fetchDelta: fetchDeltaMock,
      decryptItems: decryptMock,
      migrateItems: migrateMock,
    })

    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('item-1')
  })

  it('applies realtime delta and persists merged state', async () => {
    vi.mocked(syncDB.getItem).mockResolvedValue({
      items: [{ id: 'item-1', type: 'person', name: 'Old', archived: false }],
    })

    const result = await itemsSyncEngine.applyRealtimeDelta({
      accountId: 'acct-1',
      decryptedDelta: [
        { id: 'item-1', type: 'person', name: 'New', archived: false } as any,
        { id: 'item-2', type: 'person', name: 'Added', archived: false } as any,
      ],
      deletedIds: new Set(['item-3']),
    })

    expect(result).toHaveLength(2)
    expect(result.find(item => item.id === 'item-1')?.name).toBe('New')
    expect(result.find(item => item.id === 'item-2')?.name).toBe('Added')
    expect(syncDB.setItem).toHaveBeenCalledWith('items-sync-engine_acct-1', { items: result })
  })
})
