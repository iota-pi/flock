import * as Automerge from '@automerge/automerge'
import {
  reconcileAutomergeList,
  applyItemUpdatesToDraft,
  getElementKey,
  updateObjectInPlace,
} from './crdtReconcile'
import type { ItemId } from '@vault/shared'

type Note = { id: string; text: string; archived: boolean; time: number }

describe('crdtReconcile', () => {
  describe('reconcileAutomergeList - primitive values', () => {
    it('appends elements cleanly', () => {
      const list = [1, 2, 3]
      reconcileAutomergeList(list, [1, 2, 3, 4, 5])
      expect(list).toEqual([1, 2, 3, 4, 5])
    })

    it('prepends elements cleanly', () => {
      const list = [3, 4, 5]
      reconcileAutomergeList(list, [1, 2, 3, 4, 5])
      expect(list).toEqual([1, 2, 3, 4, 5])
    })

    it('removes elements in the middle cleanly', () => {
      const list = ['a', 'b', 'c', 'd']
      reconcileAutomergeList(list, ['a', 'd'])
      expect(list).toEqual(['a', 'd'])
    })

    it('handles replacement in the middle', () => {
      const list = ['a', 'b', 'c']
      reconcileAutomergeList(list, ['a', 'x', 'c'])
      expect(list).toEqual(['a', 'x', 'c'])
    })

    it('handles multiple non-trivial edits via LCS', () => {
      const list = [1, 2, 3, 4, 5, 6]
      reconcileAutomergeList(list, [1, 9, 3, 5, 10])
      expect(list).toEqual([1, 9, 3, 5, 10])
    })

    it('handles clearing the list', () => {
      const list = [1, 2, 3]
      reconcileAutomergeList(list, [])
      expect(list).toEqual([])
    })

    it('is a no-op when arrays are identical', () => {
      const list = ['x', 'y', 'z']
      const spy = vi.spyOn(list, 'splice')

      reconcileAutomergeList(list, ['x', 'y', 'z'])
      expect(spy).not.toHaveBeenCalled()
      expect(list).toEqual(['x', 'y', 'z'])
    })
  })

  describe('reconcileAutomergeList - keyed objects', () => {
    it('preserves existing object references while updating fields in place', () => {
      const note1: Note = { id: 'n1', text: 'original', archived: false, time: 100 }
      const note2: Note = { id: 'n2', text: 'second', archived: false, time: 200 }
      const list = [note1, note2]

      const updatedNote1: Note = { id: 'n1', text: 'updated text', archived: true, time: 150 }
      reconcileAutomergeList(list, [updatedNote1, note2])

      // The object in list[0] must be the exact same reference mutated in place!
      expect(list[0]).toBe(note1)
      expect(list[0]).toEqual({ id: 'n1', text: 'updated text', archived: true, time: 150 })
      expect(list[1]).toBe(note2)
    })

    it('inserts new notes at the target position', () => {
      const note1: Note = { id: 'n1', text: 'first', archived: false, time: 100 }
      const list = [note1]

      const newNote: Note = { id: 'n0', text: 'new prepended note', archived: false, time: 50 }
      reconcileAutomergeList(list, [newNote, note1])

      expect(list.length).toBe(2)
      expect(list[0]).toEqual(newNote)
      expect(list[1]).toBe(note1)
    })

    it('removes deleted notes', () => {
      const note1: Note = { id: 'n1', text: 'first', archived: false, time: 100 }
      const note2: Note = { id: 'n2', text: 'second', archived: false, time: 200 }
      const list = [note1, note2]

      reconcileAutomergeList(list, [note2])

      expect(list.length).toBe(1)
      expect(list[0]).toBe(note2)
    })

    it('correctly reorders existing keyed notes', () => {
      const note1: Note = { id: 'n1', text: 'first', archived: false, time: 100 }
      const note2: Note = { id: 'n2', text: 'second', archived: false, time: 200 }
      const list = [note1, note2]

      reconcileAutomergeList(list, [note2, note1])

      expect(list.length).toBe(2)
      expect(list[0].id).toBe('n2')
      expect(list[1].id).toBe('n1')
    })

    it('reorders keyed notes while updating their fields in place', () => {
      const note1: Note = { id: 'n1', text: 'first', archived: false, time: 100 }
      const note2: Note = { id: 'n2', text: 'second', archived: false, time: 200 }
      const list = [note1, note2]

      const updatedNote2: Note = { id: 'n2', text: 'second updated', archived: true, time: 250 }
      reconcileAutomergeList(list, [updatedNote2, note1])

      expect(list.length).toBe(2)
      expect(list[0].id).toBe('n2')
      expect(list[0].text).toBe('second updated')
      expect(list[0].archived).toBe(true)
      expect(list[1]).toBe(note1)
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

    it('handles non-array inputs gracefully without throwing', () => {
      expect(() => reconcileAutomergeList(null as any, [1, 2])).not.toThrow()
      expect(() => reconcileAutomergeList([1, 2], null as any)).not.toThrow()
    })

    it('correctly resolves element keys via getElementKey', () => {
      expect(getElementKey('foo')).toBe('foo')
      expect(getElementKey(123)).toBe(123)
      expect(getElementKey({ id: 'item-1', name: 'Test' })).toBe('item-1')
      const unkeyed = { name: 'No ID' }
      expect(getElementKey(unkeyed)).toBe(unkeyed)
      expect(getElementKey(null)).toBe(null)
    })

    it('updates object fields in place without replacing references via updateObjectInPlace', () => {
      const existing = { a: 0, d: 4 }
      const target = { a: 1, b: 2, c: undefined }
      updateObjectInPlace(existing as any, target as any)
      expect(existing).toEqual({ a: 1, b: 2 })
    })

    it('handles single replacement with matching key in-place', () => {
      const note1: Note = { id: 'n1', text: 'original', archived: false, time: 100 }
      const list = [note1]
      const updatedNote1: Note = { id: 'n1', text: 'modified', archived: true, time: 200 }

      reconcileAutomergeList(list, [updatedNote1])

      expect(list.length).toBe(1)
      expect(list[0]).toBe(note1)
      expect(list[0].text).toBe('modified')
      expect(list[0].archived).toBe(true)
    })
  })

  describe('Automerge CRDT Merge Verification', () => {
    type TestDoc = {
      notes: Note[]
      members: ItemId[]
      prayedFor: number[]
      name: string
      description?: string
      frequency?: string
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

    it('keeps a concurrent edit to a field that a whole-item save wrote back unchanged', () => {
      const doc0 = Automerge.change(createBaseDoc(), d => {
        d.description = 'Original description'
        d.frequency = 'weekly'
      })
      const whole = JSON.parse(JSON.stringify(doc0)) as Record<string, unknown>

      for (let run = 0; run < 20; run += 1) {
        // A saves the whole item with only the frequency changed, B edits the description
        const docA = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { ...whole, frequency: 'monthly' })
        })
        const docB = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { description: 'Edited on B' })
        })

        const merged = Automerge.merge(docA, docB)
        expect(merged.description).toBe('Edited on B')
        expect(merged.frequency).toBe('monthly')
      }
    })

    it('writes nothing when a whole-item save matches the doc', () => {
      const doc0 = createBaseDoc()
      const whole = JSON.parse(JSON.stringify(doc0)) as Record<string, unknown>
      const doc1 = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, whole)
      })
      expect(Automerge.getHeads(doc1)).toEqual(Automerge.getHeads(doc0))
    })

    it('merges concurrent edits to different parts of the same string', () => {
      const doc0 = Automerge.change(createBaseDoc(), d => {
        d.description = 'one two'
      })
      const docA = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { description: 'zero one two' }, ['description'])
      })
      const docB = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { description: 'one two three' }, ['description'])
      })
      expect(Automerge.merge(docA, docB).description).toBe('zero one two three')
    })

    it('lets one concurrent edit win for a string that is not merged text', () => {
      const doc0 = createBaseDoc()
      const docA = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { name: 'Test Item A' }, ['description'])
      })
      const docB = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { name: 'Test Item B' }, ['description'])
      })

      const merged = Automerge.merge(Automerge.clone(docA), docB)
      expect(['Test Item A', 'Test Item B']).toContain(merged.name)
      expect(Automerge.merge(Automerge.clone(docB), docA).name).toBe(merged.name)
    })

    it('keeps a value that two devices set concurrently intact', () => {
      const doc0 = Automerge.change(createBaseDoc(), d => {
        d.frequency = 'one'
      })
      const setToAll = () => Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { frequency: 'all' })
      })
      expect(Automerge.merge(setToAll(), setToAll()).frequency).toBe('all')
    })

    it('merges text in a listed field of a list element', () => {
      const doc0 = createBaseDoc()
      const docA = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { notes: [{ id: 'n1', text: 'A: Note 1', archived: false, time: 100 }] }, ['text'])
      })
      const docB = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, { notes: [{ id: 'n1', text: 'Note 1 from B', archived: false, time: 100 }] }, ['text'])
      })
      expect(Automerge.merge(docA, docB).notes[0].text).toBe('A: Note 1 from B')
    })

    it('merges concurrent edits to the same note texts while notes are inserted around them', () => {
      const doc0 = Automerge.change(createBaseDoc(), d => {
        d.notes.push({ id: 'n2', text: 'Note 2', archived: false, time: 200 })
      })
      // A inserts notes on both sides of n1 (the LCS path) and edits n1 and n2 (the suffix path)
      const docA = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, {
          notes: [
            { id: 'n3', text: 'Note 3', archived: false, time: 300 },
            { id: 'n1', text: 'Note 1 from A', archived: false, time: 100 },
            { id: 'n4', text: 'Note 4', archived: false, time: 400 },
            { id: 'n2', text: 'Note 2 from A', archived: false, time: 200 },
          ],
        }, ['text'])
      })
      const docB = Automerge.change(Automerge.clone(doc0), d => {
        applyItemUpdatesToDraft(d, {
          notes: [
            { id: 'n1', text: 'B: Note 1', archived: false, time: 100 },
            { id: 'n2', text: 'B: Note 2', archived: false, time: 200 },
          ],
        }, ['text'])
      })
      const merged = Automerge.merge(docA, docB)
      expect(merged.notes.map(n => n.text)).toEqual([
        'Note 3',
        'B: Note 1 from A',
        'Note 4',
        'B: Note 2 from A',
      ])
    })

    describe('nested objects', () => {
      type NestedDoc = {
        name: string
        details: { phone?: string; email?: string; bio?: string; tags?: string[] }
        when?: Date
        bytes?: Uint8Array
        extra?: { a: number } | number
      }

      function createNestedDoc(): Automerge.Doc<NestedDoc> {
        return Automerge.change(Automerge.init<NestedDoc>(), d => {
          d.name = 'Test Item'
          d.details = { phone: '123', email: 'a@example.com', bio: 'one two', tags: ['x'] }
        })
      }

      function plain(doc: Automerge.Doc<NestedDoc>): Record<string, unknown> {
        return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>
      }

      it('keeps concurrent edits to different fields of a nested object', () => {
        const doc0 = createNestedDoc()
        const whole = plain(doc0)
        const details = whole.details as NestedDoc['details']
        const docA = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { ...whole, details: { ...details, phone: '456' } })
        })
        const docB = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { ...whole, details: { ...details, email: 'b@example.com' } })
        })

        const merged = Automerge.merge(docA, docB)
        expect(merged.details.phone).toBe('456')
        expect(merged.details.email).toBe('b@example.com')
      })

      it('merges concurrent edits to different parts of a nested string', () => {
        const doc0 = createNestedDoc()
        const whole = plain(doc0)
        const details = whole.details as NestedDoc['details']
        const docA = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { ...whole, details: { ...details, bio: 'zero one two' } }, ['bio'])
        })
        const docB = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { ...whole, details: { ...details, bio: 'one two three' } }, ['bio'])
        })

        expect(Automerge.merge(docA, docB).details.bio).toBe('zero one two three')
      })

      it('writes nothing when a nested object is unchanged', () => {
        const doc0 = createNestedDoc()
        const doc1 = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, plain(doc0))
        })
        expect(Automerge.getHeads(doc1)).toEqual(Automerge.getHeads(doc0))
      })

      it('adds and removes nested keys in place', () => {
        const doc0 = createNestedDoc()
        const doc1 = Automerge.change(Automerge.clone(doc0), d => {
          const detailsBefore = d.details
          applyItemUpdatesToDraft(d, { details: { phone: '123', bio: 'one two', tags: ['x', 'y'] } })
          expect(d.details).toBe(detailsBefore)
        })
        expect(doc1.details).toEqual({ phone: '123', bio: 'one two', tags: ['x', 'y'] })
      })

      it('replaces an object with a scalar and a scalar with an object', () => {
        const doc0 = Automerge.change(createNestedDoc(), d => {
          d.extra = { a: 1 }
        })
        const doc1 = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { extra: 2 })
        })
        expect(doc1.extra).toBe(2)
        const doc2 = Automerge.change(doc1, d => {
          applyItemUpdatesToDraft(d, { extra: { a: 3 } })
        })
        expect(doc2.extra).toEqual({ a: 3 })
      })

      it('replaces dates and bytes rather than treating them as nested objects', () => {
        const doc0 = Automerge.change(createNestedDoc(), d => {
          d.when = new Date(1000)
          d.bytes = new Uint8Array([1, 2])
        })
        const doc1 = Automerge.change(Automerge.clone(doc0), d => {
          applyItemUpdatesToDraft(d, { when: new Date(2000), bytes: new Uint8Array([3]) })
        })
        expect(doc1.when).toEqual(new Date(2000))
        expect(doc1.bytes).toEqual(new Uint8Array([3]))
      })
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
