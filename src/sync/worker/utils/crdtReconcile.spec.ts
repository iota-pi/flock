import * as Automerge from '@automerge/automerge'
import {
  reconcilePrimitiveArray,
  reconcileKeyedArray,
  applyItemUpdatesToDraft,
} from './crdtReconcile'
import type { Note, ItemId } from 'src/shared/schemas/items'

describe('crdtReconcile', () => {
  describe('reconcilePrimitiveArray', () => {
    it('appends elements cleanly', () => {
      const list = [1, 2, 3]
      reconcilePrimitiveArray(list, [1, 2, 3, 4, 5])
      expect(list).toEqual([1, 2, 3, 4, 5])
    })

    it('prepends elements cleanly', () => {
      const list = [3, 4, 5]
      reconcilePrimitiveArray(list, [1, 2, 3, 4, 5])
      expect(list).toEqual([1, 2, 3, 4, 5])
    })

    it('removes elements in the middle cleanly', () => {
      const list = ['a', 'b', 'c', 'd']
      reconcilePrimitiveArray(list, ['a', 'd'])
      expect(list).toEqual(['a', 'd'])
    })

    it('handles replacement in the middle', () => {
      const list = ['a', 'b', 'c']
      reconcilePrimitiveArray(list, ['a', 'x', 'c'])
      expect(list).toEqual(['a', 'x', 'c'])
    })

    it('handles multiple non-trivial edits via LCS', () => {
      const list = [1, 2, 3, 4, 5, 6]
      reconcilePrimitiveArray(list, [1, 9, 3, 5, 10])
      expect(list).toEqual([1, 9, 3, 5, 10])
    })

    it('handles clearing the list', () => {
      const list = [1, 2, 3]
      reconcilePrimitiveArray(list, [])
      expect(list).toEqual([])
    })

    it('is a no-op when arrays are identical', () => {
      const list = ['x', 'y', 'z']
      const spy = vi.spyOn(list, 'splice')

      reconcilePrimitiveArray(list, ['x', 'y', 'z'])
      expect(spy).not.toHaveBeenCalled()
      expect(list).toEqual(['x', 'y', 'z'])
    })
  })

  describe('reconcileKeyedArray', () => {
    it('preserves existing object references while updating fields in place', () => {
      const note1: Note = { id: 'n1', text: 'original', archived: false, time: 100 }
      const note2: Note = { id: 'n2', text: 'second', archived: false, time: 200 }
      const list = [note1, note2]

      const updatedNote1: Note = { id: 'n1', text: 'updated text', archived: true, time: 150 }
      reconcileKeyedArray(list, [updatedNote1, note2])

      // The object in list[0] must be the exact same reference mutated in place!
      expect(list[0]).toBe(note1)
      expect(list[0]).toEqual({ id: 'n1', text: 'updated text', archived: true, time: 150 })
      expect(list[1]).toBe(note2)
    })

    it('inserts new notes at the target position', () => {
      const note1: Note = { id: 'n1', text: 'first', archived: false, time: 100 }
      const list = [note1]

      const newNote: Note = { id: 'n0', text: 'new prepended note', archived: false, time: 50 }
      reconcileKeyedArray(list, [newNote, note1])

      expect(list.length).toBe(2)
      expect(list[0]).toEqual(newNote)
      expect(list[1]).toBe(note1)
    })

    it('removes deleted notes', () => {
      const note1: Note = { id: 'n1', text: 'first', archived: false, time: 100 }
      const note2: Note = { id: 'n2', text: 'second', archived: false, time: 200 }
      const list = [note1, note2]

      reconcileKeyedArray(list, [note2])

      expect(list.length).toBe(1)
      expect(list[0]).toBe(note2)
    })
  })

  describe('reconcileAutomergeList & applyItemUpdatesToDraft', () => {
    it('correctly applies scalar updates and reconciles lists in-place', () => {
      const draft: any = {
        name: 'Old Name',
        archived: false,
        members: ['m1', 'm2'],
        notes: [{ id: 'n1', text: 'hello', archived: false, time: 100 }],
        prayedFor: [1000],
      }

      const existingMembersRef = draft.members
      const existingNotesRef = draft.notes
      const existingNoteObjRef = draft.notes[0]
      const existingPrayedForRef = draft.prayedFor

      applyItemUpdatesToDraft(draft, {
        name: 'New Name',
        members: ['m1', 'm2', 'm3'] as ItemId[],
        notes: [
          { id: 'n2', text: 'note 2', archived: false, time: 200 },
          { id: 'n1', text: 'hello edited', archived: true, time: 100 },
        ],
        prayedFor: [1000, 2000],
      })

      expect(draft.name).toBe('New Name')
      // Array references must be preserved!
      expect(draft.members).toBe(existingMembersRef)
      expect(draft.members).toEqual(['m1', 'm2', 'm3'])

      expect(draft.prayedFor).toBe(existingPrayedForRef)
      expect(draft.prayedFor).toEqual([1000, 2000])

      expect(draft.notes).toBe(existingNotesRef)
      // Note 1 object reference inside the list must be preserved!
      const foundNote1 = draft.notes.find((n: any) => n.id === 'n1')
      expect(foundNote1).toBe(existingNoteObjRef)
      expect(foundNote1.text).toBe('hello edited')
      expect(foundNote1.archived).toBe(true)
    })
  })

  describe('Automerge CRDT Merge Verification', () => {
    type TestDoc = {
      notes: Note[]
      members: ItemId[]
      prayedFor: number[]
      name: string
    }

    function createBaseDoc(): Automerge.Doc<TestDoc> {
      let doc = Automerge.init<TestDoc>()
      doc = Automerge.change(doc, d => {
        d.name = 'Test Item'
        d.notes = [{ id: 'n1', text: 'Note 1', archived: false, time: 100 }]
        d.members = ['m1' as ItemId]
        d.prayedFor = [1000]
      })
      return doc
    }

    it('merges concurrent note additions across devices without losing either note', () => {
      const doc0 = createBaseDoc()

      // Fork to Device A and Device B
      let docA = Automerge.clone(doc0)
      let docB = Automerge.clone(doc0)

      // Device A adds Note 2
      const note2: Note = { id: 'n2', text: 'Note 2 from Device A', archived: false, time: 200 }
      docA = Automerge.change(docA, d => {
        applyItemUpdatesToDraft(d, {
          notes: [note2, ...d.notes],
        })
      })

      // Device B concurrently adds Note 3
      const note3: Note = { id: 'n3', text: 'Note 3 from Device B', archived: false, time: 300 }
      docB = Automerge.change(docB, d => {
        applyItemUpdatesToDraft(d, {
          notes: [note3, ...d.notes],
        })
      })

      // Merge Device A and Device B
      const merged = Automerge.merge(docA, docB)

      const noteIds = merged.notes.map(n => n.id)
      expect(noteIds).toContain('n1')
      expect(noteIds).toContain('n2')
      expect(noteIds).toContain('n3')
      expect(merged.notes.length).toBe(3)
    })

    it('demonstrates that naive whole-array assignment loses concurrent additions (contrast)', () => {
      const doc0 = createBaseDoc()
      let docA = Automerge.clone(doc0)
      let docB = Automerge.clone(doc0)

      const note2: Note = { id: 'n2', text: 'Note 2', archived: false, time: 200 }
      const note3: Note = { id: 'n3', text: 'Note 3', archived: false, time: 300 }

      // Plain array representation as received from React/Zustand client state
      const plainNotes = JSON.parse(JSON.stringify(doc0.notes)) as Note[]

      // Naive whole-array assignment with plain objects
      docA = Automerge.change(docA, d => {
        d.notes = [note2, ...plainNotes]
      })
      docB = Automerge.change(docB, d => {
        d.notes = [note3, ...plainNotes]
      })

      const merged = Automerge.merge(docA, docB)
      // Because whole array was assigned, Automerge treated d.notes as a register conflict (LWW).
      // Only 2 notes exist in merged doc, one device's addition was discarded!
      expect(merged.notes.length).toBe(2)
      expect(merged.notes.length).not.toBe(3)
    })

    it('merges concurrent note field edits (text vs archive status)', () => {
      const doc0 = createBaseDoc()
      let docA = Automerge.clone(doc0)
      let docB = Automerge.clone(doc0)

      // Device A edits note 1 text
      docA = Automerge.change(docA, d => {
        applyItemUpdatesToDraft(d, {
          notes: [{ id: 'n1', text: 'Edited text from A', archived: false, time: 100 }],
        })
      })

      // Device B concurrently archives note 1
      docB = Automerge.change(docB, d => {
        applyItemUpdatesToDraft(d, {
          notes: [{ id: 'n1', text: 'Note 1', archived: true, time: 100 }],
        })
      })

      const merged = Automerge.merge(docA, docB)
      expect(merged.notes.length).toBe(1)
      expect(merged.notes[0].text).toBe('Edited text from A')
      expect(merged.notes[0].archived).toBe(true)
    })

    it('merges concurrent group member additions across devices', () => {
      const doc0 = createBaseDoc()
      let docA = Automerge.clone(doc0)
      let docB = Automerge.clone(doc0)

      // Device A adds member m2
      docA = Automerge.change(docA, d => {
        applyItemUpdatesToDraft(d, {
          members: [...d.members, 'm2' as ItemId],
        })
      })

      // Device B concurrently adds member m3
      docB = Automerge.change(docB, d => {
        applyItemUpdatesToDraft(d, {
          members: [...d.members, 'm3' as ItemId],
        })
      })

      const merged = Automerge.merge(docA, docB)
      expect(merged.members).toContain('m1')
      expect(merged.members).toContain('m2')
      expect(merged.members).toContain('m3')
      expect(merged.members.length).toBe(3)
    })

    it('merges concurrent prayer recordings across devices', () => {
      const doc0 = createBaseDoc()
      let docA = Automerge.clone(doc0)
      let docB = Automerge.clone(doc0)

      // Device A records prayer at 2000
      docA = Automerge.change(docA, d => {
        applyItemUpdatesToDraft(d, {
          prayedFor: [...d.prayedFor, 2000],
        })
      })

      // Device B concurrently records prayer at 3000
      docB = Automerge.change(docB, d => {
        applyItemUpdatesToDraft(d, {
          prayedFor: [...d.prayedFor, 3000],
        })
      })

      const merged = Automerge.merge(docA, docB)
      expect(merged.prayedFor).toContain(1000)
      expect(merged.prayedFor).toContain(2000)
      expect(merged.prayedFor).toContain(3000)
      expect(merged.prayedFor.length).toBe(3)
    })
  })
})
