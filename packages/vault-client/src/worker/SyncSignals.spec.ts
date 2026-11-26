import type { ItemId } from '@vault/shared'
import { SyncSignals, type SyncSignalHandlers } from './SyncSignals'

function handlers(overrides: Partial<SyncSignalHandlers> = {}): SyncSignalHandlers {
  return {
    workDue: vi.fn(),
    snapshotDue: vi.fn(),
    pollNow: vi.fn().mockResolvedValue(undefined),
    activity: vi.fn(),
    edited: vi.fn(),
    localChangesFound: vi.fn(),
    localDataMissing: vi.fn(),
    metadataUpdated: vi.fn(),
    askManifest: vi.fn(),
    ...overrides,
  }
}

describe('SyncSignals', () => {
  it('carries a signal to its bound handler', () => {
    const signals = new SyncSignals()
    const edited = vi.fn()
    signals.bind(handlers({ edited }))

    signals.raise.edited('item-1' as ItemId)

    expect(edited).toHaveBeenCalledWith('item-1')
  })

  // A signal raised before binding is a wiring bug, which must not be dropped silently
  it('throws when a signal is raised before its handlers are bound', () => {
    const signals = new SyncSignals()

    expect(() => signals.raise.workDue()).toThrow('before its handlers were bound')
  })

  it('binds only once', () => {
    const signals = new SyncSignals()
    signals.bind(handlers())

    expect(() => signals.bind(handlers())).toThrow('already bound')
  })
})
