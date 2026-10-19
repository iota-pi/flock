import * as Automerge from '@automerge/automerge'

/**
 * The control for the local encryption acceptance test (cypress/e2e/local-encryption.cy.ts), which
 * searches the device's storage for a person's name. Automerge compresses larger columns, so that
 * search only means something if an unencrypted chunk would contain a short name verbatim.
 */
describe('local encryption acceptance test control', () => {
  const name = 'Pippin_123456'
  const nameBytes = Buffer.from(name)

  it('finds a short name in a saved Automerge document', () => {
    const doc = Automerge.from({ id: 'item-1', type: 'person', name })

    expect(Buffer.from(Automerge.save(doc)).includes(nameBytes)).toBe(true)
  })

  it('finds a short name in an incremental change', () => {
    const doc = Automerge.from<{ name?: string }>({})
    const changed = Automerge.change(doc, draft => {
      draft.name = name
    })

    expect(Buffer.from(Automerge.saveSince(changed, Automerge.getHeads(doc))).includes(nameBytes)).toBe(true)
  })
})
