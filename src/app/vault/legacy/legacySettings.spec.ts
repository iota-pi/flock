import { flockLegacySettings, mergeLegacySettings } from './legacySettings'
import type { AccountMetadata } from '../../../state/metadata'
import type { LegacySettingsContext } from '@vault/client/sync/worker/domain'

const mockGetMetadata = vi.fn()
const mockClearMetadata = vi.fn()
vi.mock('../../../api/trpcClient', () => ({
  createTrpcClient: () => ({
    accounts: {
      getMetadata: { query: (...args: unknown[]) => mockGetMetadata(...args) },
      clearMetadata: { mutate: (...args: unknown[]) => mockClearMetadata(...args) },
    },
  }),
}))

describe('legacySettings', () => {
  describe('mergeLegacySettings', () => {
    it('returns nothing when neither side has synced settings', () => {
      const local: AccountMetadata = { sortCriteria: [{ type: 'name', reverse: false }] }
      expect(mergeLegacySettings(local, {})).toEqual({})
    })

    it('takes local settings when the server has none, dropping local-only keys and updatedAt', () => {
      const local: AccountMetadata = {
        prayerGoal: 5,
        defaultPrayerFrequency: { person: 'daily' },
        sortCriteria: [{ type: 'created', reverse: true }],
        updatedAt: 1000,
      }
      expect(mergeLegacySettings(local, {})).toEqual({
        prayerGoal: 5,
        defaultPrayerFrequency: { person: 'daily' },
      })
    })

    it('takes server settings when the device has none', () => {
      const remote: AccountMetadata = {
        prayerGoal: 10,
        defaultPrayerFrequency: { person: 'weekly', group: 'monthly' },
        completedMigrations: ['m1'],
        autoSnoozeWhenCompleted: true,
        updatedAt: 1000,
      }
      expect(mergeLegacySettings({}, remote)).toEqual({
        prayerGoal: 10,
        defaultPrayerFrequency: { person: 'weekly', group: 'monthly' },
        completedMigrations: ['m1'],
        autoSnoozeWhenCompleted: true,
      })
    })

    it('merges non-overlapping fields from both sides', () => {
      const local: AccountMetadata = { prayerGoal: 7, updatedAt: 2000 }
      const remote: AccountMetadata = {
        defaultPrayerFrequency: { topic: 'daily' },
        completedMigrations: ['mig-a'],
        updatedAt: 1000,
      }
      expect(mergeLegacySettings(local, remote)).toEqual({
        prayerGoal: 7,
        defaultPrayerFrequency: { topic: 'daily' },
        completedMigrations: ['mig-a'],
      })
    })

    it('unions completedMigrations', () => {
      const local: AccountMetadata = { completedMigrations: ['mig-1', 'mig-2'], updatedAt: 100 }
      const remote: AccountMetadata = { completedMigrations: ['mig-2', 'mig-3'], updatedAt: 100 }
      expect(mergeLegacySettings(local, remote).completedMigrations).toEqual(['mig-1', 'mig-2', 'mig-3'])
    })

    it('resolves conflicting scalars by updatedAt', () => {
      expect(mergeLegacySettings(
        { prayerGoal: 15, autoSnoozeWhenCompleted: true, updatedAt: 5000 },
        { prayerGoal: 10, autoSnoozeWhenCompleted: false, updatedAt: 4000 },
      )).toEqual({ prayerGoal: 15, autoSnoozeWhenCompleted: true })

      expect(mergeLegacySettings(
        { prayerGoal: 15, autoSnoozeWhenCompleted: true, updatedAt: 4000 },
        { prayerGoal: 20, autoSnoozeWhenCompleted: false, updatedAt: 5000 },
      )).toEqual({ prayerGoal: 20, autoSnoozeWhenCompleted: false })
    })

    it('merges defaultPrayerFrequency per field, the newer side winning conflicts', () => {
      const local: AccountMetadata = {
        defaultPrayerFrequency: { person: 'daily', group: 'weekly' },
        updatedAt: 3000,
      }
      const remote: AccountMetadata = {
        defaultPrayerFrequency: { person: 'monthly', topic: 'weekly' },
        updatedAt: 2000,
      }
      expect(mergeLegacySettings(local, remote).defaultPrayerFrequency).toEqual({
        person: 'daily',
        group: 'weekly',
        topic: 'weekly',
      })
    })
  })

  describe('flockLegacySettings', () => {
    const context: LegacySettingsContext = {
      accountId: 'acct-1',
      withAuth: request => request(),
    }

    beforeEach(() => {
      mockGetMetadata.mockReset()
      mockClearMetadata.mockReset()
    })

    it('merges the server copy with the device copy', async () => {
      mockGetMetadata.mockResolvedValue({ success: true, metadata: { prayerGoal: 20, updatedAt: 5000 } })

      const result = await flockLegacySettings.load({ prayerGoal: 15, updatedAt: 4000 }, context)

      expect(mockGetMetadata).toHaveBeenCalledWith({ account: 'acct-1' })
      expect(result).toEqual({ prayerGoal: 20 })
    })

    it('returns null once there is nothing left to migrate', async () => {
      mockGetMetadata.mockResolvedValue({ success: true, metadata: {} })

      await expect(flockLegacySettings.load({ sortCriteria: [] }, context)).resolves.toBeNull()
    })

    it('runs requests through withAuth', async () => {
      mockGetMetadata.mockResolvedValue({ success: true, metadata: {} })
      const withAuth = vi.fn((request: () => Promise<unknown>) => request()) as LegacySettingsContext['withAuth']

      await flockLegacySettings.load({}, { ...context, withAuth })
      await flockLegacySettings.clear({ ...context, withAuth })

      expect(withAuth).toHaveBeenCalledTimes(2)
      expect(mockClearMetadata).toHaveBeenCalledWith({ account: 'acct-1' })
    })

    it('removes the legacy merge timestamp from local metadata', () => {
      expect(flockLegacySettings.obsoleteLocalKeys).toEqual(['updatedAt'])
    })
  })
})
