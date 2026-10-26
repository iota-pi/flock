import { handleMigrationMessage } from './migrationTakeover'
import * as session from './session'
import { useAppStore } from '../../state/store'

describe('handleMigrationMessage', () => {
  beforeEach(() => {
    vi.spyOn(session, 'lockVault').mockResolvedValue(undefined)
    useAppStore.setState({ loggedIn: true, message: null })
  })

  it('locks this tab when the migration app starts in another', async () => {
    await handleMigrationMessage({ type: 'started', account: 'acct-1' })

    expect(session.lockVault).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().message?.message).toMatch(/being updated in another tab/)
  })

  it('ignores the message while locked', async () => {
    useAppStore.setState({ loggedIn: false })
    await handleMigrationMessage({ type: 'started', account: 'acct-1' })
    expect(session.lockVault).not.toHaveBeenCalled()
  })

  it('ignores other messages', async () => {
    await handleMigrationMessage({ type: 'finished', account: 'acct-1' })
    await handleMigrationMessage(undefined)
    expect(session.lockVault).not.toHaveBeenCalled()
  })
})
