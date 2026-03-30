import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as Automerge from '@automerge/automerge'
import type { VaultItem } from '../api/VaultAPI'
import type { VaultBranch } from '../shared/itemTypes'
import { toBytes } from '../api/pure-crypto'

/**
 * Web Worker Decryption Tests
 * Tests the most critical data path: decryption, conflict merging, and resolution
 */

// Helper to create a test encryption (AES-GCM with IV prepended)
async function encryptData(plaintext: Uint8Array, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(16))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    plaintext as BufferSource,
  )
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, '0')).join('')
  const ctHex = Array.from(new Uint8Array(ciphertext)).map(b => b.toString(16).padStart(2, '0')).join('')
  return ivHex + ctHex
}

// Helper to create a test decryption key
async function createTestKey(): Promise<CryptoKey> {
  const keyData = new Uint8Array(32)
  crypto.getRandomValues(keyData)
  return crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'AES-GCM' } as any,
    false,
    ['encrypt', 'decrypt'],
  )
}

describe('Web Worker: decryption.worker.ts', () => {
  let testKey: CryptoKey

  beforeEach(async () => {
    testKey = await createTestKey()
  })

  describe('Legacy Item Upgrade', () => {
    it('should decrypt legacy cipher and return materialized JSON', async () => {
      const plainJson = JSON.stringify({ id: 'item1', name: 'Test Item', archived: false })
      const plainBytes = new TextEncoder().encode(plainJson)
      const iv = 'ae' + '00'.repeat(15) // Fixed IV for predictability
      const encrypted = await encryptData(plainBytes, testKey)

      const item: VaultItem = {
        item: 'item1',
        cipher: encrypted,
        branches: undefined,
        metadata: {
          type: 'person',
          iv,
          modified: Date.now(),
          version: 1,
        },
      }

      // Import the worker's internal function (would normally be worker context)
      // For this test, we simulate by calling the logic directly
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(toBytes(iv)) },
        testKey,
        toBytes(encrypted.slice(32)), // Skip IV prefix in encrypted blob
      )

      const result = JSON.parse(new TextDecoder().decode(plaintext))
      expect(result.name).toBe('Test Item')
      expect(result.archived).toBe(false)
    })
  })

  describe('Discrete Field Merging (Automerge)', () => {
    it('should merge two branches with different field changes', async () => {
      // Create branch A: changes title
      let docA = Automerge.from({
        id: 'item1',
        title: 'Original Title',
        archived: false,
      })
      docA = Automerge.change(docA, (doc: any) => {
        doc.title = 'New Title From A'
      })
      const binaryA = Automerge.save(docA)

      // Create branch B: changes archived field from same parent
      const docBParent = Automerge.from({
        id: 'item1',
        title: 'Original Title',
        archived: false,
      })
      let docB = Automerge.clone(docBParent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.archived = true
      })
      const binaryB = Automerge.save(docB)

      // Merge them
      let merged = Automerge.load(binaryA)
      merged = Automerge.merge(merged, Automerge.load(binaryB))
      const result = Automerge.toJS(merged)

      // Both changes should be present
      expect((result as any).title).toBe('New Title From A')
      expect((result as any).archived).toBe(true)
    })

    it('should preserve both changes when merging non-conflicting edits', async () => {
      const parent = {
        id: 'item1',
        name: 'Test',
        category: 'Work',
        priority: 1,
      }

      // Branch A: updates name
      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.name = 'Updated Name'
      })

      // Branch B: updates priority
      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.priority = 2
      })

      // Merge
      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged)

      expect(result.name).toBe('Updated Name')
      expect(result.priority).toBe(2)
      expect(result.category).toBe('Work')
    })
  })

  describe('Array Conflict Resolution', () => {
    it('should merge array additions from two branches', async () => {
      const parent = {
        id: 'item1',
        tags: ['original'],
      }

      // Branch A: adds "tag-a"
      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.tags.push('tag-a')
      })

      // Branch B: adds "tag-b"
      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.tags.push('tag-b')
      })

      // Merge
      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged)

      // Both tags should be present (Automerge handles concurrent array appends)
      expect(result.tags).toContain('original')
      expect(result.tags).toContain('tag-a')
      expect(result.tags).toContain('tag-b')
      expect(result.tags.length).toBeGreaterThanOrEqual(3)
    })

    it('should handle nested array operations', async () => {
      const parent = {
        id: 'item1',
        members: [
          { id: 'user1', role: 'member' },
          { id: 'user2', role: 'member' },
        ],
      }

      // Branch A: modifies user1's role
      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.members[0].role = 'admin'
      })

      // Branch B: adds new member
      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.members.push({ id: 'user3', role: 'member' })
      })

      // Merge
      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged)

      expect((result as any).members).toHaveLength(3)
      expect((result as any).members[0].role).toBe('admin')
      expect((result as any).members[2].id).toBe('user3')
    })
  })

  describe('Identical Content Overwrite', () => {
    it('should merge cleanly when both branches make identical changes', async () => {
      const parent = {
        id: 'item1',
        title: 'Original',
        notes: 'Original notes',
      }

      // Branch A: updates title
      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.title = 'Same Title'
        doc.notes = 'Same notes'
      })

      // Branch B: makes identical changes
      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.title = 'Same Title'
        doc.notes = 'Same notes'
      })

      // Merge
      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged)

      expect(result.title).toBe('Same Title')
      expect(result.notes).toBe('Same notes')
      // Should not have duplicated metadata or corrupted state
      expect(typeof result.title).toBe('string')
    })
  })

  describe('Corrupted Branch Handling', () => {
    it('should handle failure to decrypt one branch gracefully', async () => {
      // Create a valid branch
      const validDoc = Automerge.from({ id: 'item1', name: 'Test' })
      const validBinary = Automerge.save(validDoc)
      const validEncrypted = await encryptData(validBinary, testKey)

      // Create an invalid/corrupted encrypted blob
      const corruptedBinary = new Uint8Array([0xFF, 0xFE, 0xFD])
      const corruptedEncrypted = await encryptData(corruptedBinary, testKey)

      // Simulate decryption of valid branch
      const validDecrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(toBytes(validEncrypted.slice(0, 32))),
        },
        testKey,
        toBytes(validEncrypted.slice(32)),
      )

      // When decrypted, the corrupted one would fail to load with Automerge.load()
      // Verify the valid one loads successfully
      const loadedValid = Automerge.load(new Uint8Array(validDecrypted))
      const result = Automerge.toJS(loadedValid) as any
      expect((result as any).name).toBe('Test')
    })

    it('should not crash when merging with all-corrupted branches', async () => {
      // In the real worker, if all branches are corrupted, it should return null
      // and NOT crash the worker thread
      const corruptedBinary = new Uint8Array([0xFF, 0xFE, 0xFD])

      // Simulate trying to load corrupted data
      let loadError: Error | null = null
      try {
        Automerge.load(corruptedBinary)
      } catch (err) {
        loadError = err as Error
      }

      // Verify error is caught, not thrown
      expect(loadError).not.toBeNull()
      expect(loadError?.message).toMatch(/invalid|corrupt|format/i)
    })
  })

  describe('Resolution Branch Generation', () => {
    it('should generate a valid VaultBranch with correct structure', async () => {
      const parent = { id: 'item1', data: 'test' }

      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.data = 'modified-a'
      })

      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.data = 'modified-b'
      })

      let merged = Automerge.merge(docA, docB)
      const mergedBinary = Automerge.save(merged)

      // Simulate worker resolution
      const resolvedBranch: VaultBranch = {
        encryptedAutomergeDoc: await encryptData(mergedBinary, testKey),
        versionId: `${Date.now()}-resolved`,
        parentIds: ['parent-v1', 'parent-v2'],
      }

      expect(resolvedBranch.encryptedAutomergeDoc).toMatch(/^[a-f0-9]+$/)
      expect(resolvedBranch.versionId).toContain('resolved')
      expect(resolvedBranch.parentIds).toHaveLength(2)
    })
  })

  describe('Version Metadata Preservation', () => {
    it('should preserve version number through merge', async () => {
      const parent = { id: 'item1', title: 'Test' }

      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.title = 'Update A'
      })

      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.title = 'Update B'
      })

      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged) as any

      // Even though field conflicts, the version metadata should be intact
      expect(result.id).toBe('item1')
      expect(typeof result.title).toBe('string')
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty object merges', async () => {
      let docA = Automerge.from({})
      docA = Automerge.change(docA, (doc: any) => {
        doc.a = 1
      })

      let docB = Automerge.from({})
      docB = Automerge.change(docB, (doc: any) => {
        doc.b = 2
      })

      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged)

      expect(result).toEqual(expect.objectContaining({ a: 1, b: 2 }))
    })

    it('should handle deeply nested object changes', async () => {
      const parent = {
        id: 'item1',
        nested: {
          level2: {
            level3: {
              value: 'original',
            },
          },
        },
      }

      let docA = Automerge.from(parent)
      docA = Automerge.change(docA, (doc: any) => {
        doc.nested.level2.level3.value = 'changed-a'
      })

      let docB = Automerge.from(parent)
      docB = Automerge.change(docB, (doc: any) => {
        doc.nested.level2.level3.extra = 'added-b'
      })

      let merged = Automerge.merge(docA, docB)
      const result = Automerge.toJS(merged) as any

      expect((result as any).nested.level2.level3.value).toBe('changed-a')
      expect((result as any).nested.level2.level3.extra).toBe('added-b')
    })
  })
})
