import { snoozeReminders } from './notificationClient'
import { getTrpcClient } from './trpcClient'

const mockTrpcClient = {
  accounts: {
    snoozeReminders: { mutate: vi.fn() },
  },
}

vi.mock('./trpcClient', () => ({
  getTrpcClient: vi.fn(() => mockTrpcClient),
}))

describe('notificationClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('snoozes reminders for the active account', async () => {
    vi.mocked(getTrpcClient().accounts.snoozeReminders.mutate).mockResolvedValue({
      success: true,
      snoozeRemindersUntil: '2026-09-21',
    })

    await snoozeReminders('acc-1', '2026-09-21')

    expect(getTrpcClient().accounts.snoozeReminders.mutate).toHaveBeenCalledWith({
      account: 'acc-1',
      snoozeUntilDate: '2026-09-21',
    })
  })
})
