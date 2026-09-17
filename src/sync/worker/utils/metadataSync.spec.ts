import {
  hasSyncableChanges,
  reconcileAccountMetadata,
} from './metadataSync'
import type { AccountMetadata } from '../../../state/metadata'

describe('metadataSync', () => {
  describe('hasSyncableChanges', () => {
    it('returns true for defaultPrayerFrequency', () => {
      expect(hasSyncableChanges({ defaultPrayerFrequency: { person: 'daily' } })).toBe(true)
    })

    it('returns true for prayerGoal', () => {
      expect(hasSyncableChanges({ prayerGoal: 10 })).toBe(true)
    })

    it('returns true for completedMigrations', () => {
      expect(hasSyncableChanges({ completedMigrations: ['mig-1'] })).toBe(true)
    })

    it('returns false for device-local sortCriteria only', () => {
      expect(hasSyncableChanges({ sortCriteria: [{ type: 'name', reverse: false }] })).toBe(false)
    })

    it('returns false for empty changes', () => {
      expect(hasSyncableChanges({})).toBe(false)
    })
  })

  describe('reconcileAccountMetadata', () => {
    it('returns untouched metadata when both local and remote are empty', () => {
      const result = reconcileAccountMetadata({}, {})
      expect(result.merged).toEqual({})
      expect(result.needsRemotePush).toBe(false)
      expect(result.hasLocalChanges).toBe(false)
    })

    it('preserves local sortCriteria when both are empty of syncable data', () => {
      const local: AccountMetadata = {
        sortCriteria: [{ type: 'name', reverse: false }],
      }
      const result = reconcileAccountMetadata(local, {})
      expect(result.merged.sortCriteria).toEqual([{ type: 'name', reverse: false }])
      expect(result.needsRemotePush).toBe(false)
      expect(result.hasLocalChanges).toBe(false)
    })

    it('pushes local metadata when remote is empty', () => {
      const local: AccountMetadata = {
        prayerGoal: 5,
        defaultPrayerFrequency: { person: 'daily' },
        sortCriteria: [{ type: 'created', reverse: true }],
      }
      const result = reconcileAccountMetadata(local, {})
      expect(result.merged.prayerGoal).toBe(5)
      expect(result.merged.defaultPrayerFrequency).toEqual({ person: 'daily' })
      expect(result.merged.sortCriteria).toEqual([{ type: 'created', reverse: true }])
      expect(result.merged.updatedAt).toBeDefined()
      expect(result.needsRemotePush).toBe(true)
      expect(result.hasLocalChanges).toBe(true) // updatedAt was added
    })

    it('hydrates remote metadata into local when local is empty, preserving local sortCriteria', () => {
      const local: AccountMetadata = {
        sortCriteria: [{ type: 'lastPrayedFor', reverse: false }],
      }
      const remote: AccountMetadata = {
        prayerGoal: 10,
        defaultPrayerFrequency: { person: 'weekly', group: 'monthly' },
        completedMigrations: ['m1'],
        updatedAt: 1000,
      }
      const result = reconcileAccountMetadata(local, remote)
      expect(result.merged.prayerGoal).toBe(10)
      expect(result.merged.defaultPrayerFrequency).toEqual({ person: 'weekly', group: 'monthly' })
      expect(result.merged.completedMigrations).toEqual(['m1'])
      expect(result.merged.sortCriteria).toEqual([{ type: 'lastPrayedFor', reverse: false }])
      expect(result.merged.updatedAt).toBe(1000)
      expect(result.needsRemotePush).toBe(false)
      expect(result.hasLocalChanges).toBe(true)
    })

    it('merges non-overlapping fields from both local and remote', () => {
      const local: AccountMetadata = {
        prayerGoal: 7,
        updatedAt: 2000,
      }
      const remote: AccountMetadata = {
        defaultPrayerFrequency: { topic: 'daily' },
        completedMigrations: ['mig-a'],
        updatedAt: 1000,
      }
      const result = reconcileAccountMetadata(local, remote)
      expect(result.merged.prayerGoal).toBe(7)
      expect(result.merged.defaultPrayerFrequency).toEqual({ topic: 'daily' })
      expect(result.merged.completedMigrations).toEqual(['mig-a'])
      expect(result.merged.updatedAt).toBe(2000)
      expect(result.needsRemotePush).toBe(true) // remote needs prayerGoal
      expect(result.hasLocalChanges).toBe(true) // local needs defaultPrayerFrequency & migrations
    })

    it('unions completedMigrations from both sides', () => {
      const local: AccountMetadata = {
        completedMigrations: ['mig-1', 'mig-2'],
        updatedAt: 100,
      }
      const remote: AccountMetadata = {
        completedMigrations: ['mig-2', 'mig-3'],
        updatedAt: 100,
      }
      const result = reconcileAccountMetadata(local, remote)
      expect(result.merged.completedMigrations).toEqual(['mig-1', 'mig-2', 'mig-3'])
    })

    it('resolves conflicting prayerGoal by updatedAt timestamp', () => {
      const localNewer: AccountMetadata = {
        prayerGoal: 15,
        updatedAt: 5000,
      }
      const remoteOlder: AccountMetadata = {
        prayerGoal: 10,
        updatedAt: 4000,
      }
      const result1 = reconcileAccountMetadata(localNewer, remoteOlder)
      expect(result1.merged.prayerGoal).toBe(15)
      expect(result1.needsRemotePush).toBe(true)

      const localOlder: AccountMetadata = {
        prayerGoal: 15,
        updatedAt: 4000,
      }
      const remoteNewer: AccountMetadata = {
        prayerGoal: 20,
        updatedAt: 5000,
      }
      const result2 = reconcileAccountMetadata(localOlder, remoteNewer)
      expect(result2.merged.prayerGoal).toBe(20)
      expect(result2.hasLocalChanges).toBe(true)
    })

    it('merges defaultPrayerFrequency granular subfields respecting timestamp', () => {
      const local: AccountMetadata = {
        defaultPrayerFrequency: { person: 'daily', group: 'weekly' },
        updatedAt: 3000,
      }
      const remote: AccountMetadata = {
        defaultPrayerFrequency: { person: 'monthly', topic: 'weekly' },
        updatedAt: 2000,
      }
      // Local is newer, so person should be 'daily' (local), group 'weekly' (local), topic 'weekly' (remote)
      const result = reconcileAccountMetadata(local, remote)
      expect(result.merged.defaultPrayerFrequency).toEqual({
        person: 'daily',
        group: 'weekly',
        topic: 'weekly',
      })
      expect(result.needsRemotePush).toBe(true)
      expect(result.hasLocalChanges).toBe(true)
    })

    it('does not push or change local when local and remote are already in sync', () => {
      const local: AccountMetadata = {
        prayerGoal: 12,
        defaultPrayerFrequency: { person: 'daily' },
        sortCriteria: [{ type: 'name', reverse: true }],
        updatedAt: 5000,
      }
      const remote: AccountMetadata = {
        prayerGoal: 12,
        defaultPrayerFrequency: { person: 'daily' },
        updatedAt: 5000,
      }
      const result = reconcileAccountMetadata(local, remote)
      expect(result.needsRemotePush).toBe(false)
      expect(result.hasLocalChanges).toBe(false)
      expect(result.merged.sortCriteria).toEqual([{ type: 'name', reverse: true }])
    })
  })
})
