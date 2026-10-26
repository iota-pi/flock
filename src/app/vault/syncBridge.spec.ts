import { storeSink } from './syncBridge'
import { lockVault } from './session'
import { goToMigration } from '../../migrate/detection'
import { useAppStore } from '../../state/store'
import * as sessionModule from './session'
import * as detectionModule from '../../migrate/detection'
import { spyOnExports } from '../../utils/testUtils'

beforeEach(() => {
  spyOnExports(sessionModule, {
    lockVault: vi.fn().mockResolvedValue(undefined),
  })
  spyOnExports(detectionModule, {
    goToMigration: vi.fn(),
  })
})

describe('storeSink', () => {
  it('locks the vault and sends the account to the migration app when migration is required', async () => {
    useAppStore.setState({ account: 'acct-1' })

    storeSink.onMigrationRequired?.('device')

    await vi.waitFor(() => expect(goToMigration).toHaveBeenCalledWith('acct-1'))
    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(vi.mocked(lockVault).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(goToMigration).mock.invocationCallOrder[0])
  })
})
