import { handleMigrationMessage } from './migrationTakeover'
import { lockVault } from './session'
import { useAppStore } from '../../state/store'

vi.mock('./session', () => ({
  lockVault: vi.fn().mockResolvedValue(undefined),
}))

describe('handleMigrationMessage', () => {
  beforeEach(() => {
    vi.mocked(lockVault).mockClear()
    useAppStore.setState({ loggedIn: true, message: null })
  })

  it('locks this tab when the migration app starts in another', async () => {
    await handleMigrationMessage({ type: 'started', account: 'acct-1' })

    expect(lockVault).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().message?.message).toMatch(/being updated in another tab/)
  })

  it('ignores the message while locked', async () => {
    useAppStore.setState({ loggedIn: false })
    await handleMigrationMessage({ type: 'started', account: 'acct-1' })
    expect(lockVault).not.toHaveBeenCalled()
  })

  it('ignores other messages', async () => {
    await handleMigrationMessage({ type: 'finished', account: 'acct-1' })
    await handleMigrationMessage(undefined)
    expect(lockVault).not.toHaveBeenCalled()
  })
})
