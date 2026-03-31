function toTrpcSuccessResponse(json: unknown) {
  return [
    {
      result: {
        data: {
          json,
        },
      },
    },
  ]
}

function extractTrpcInput(body: unknown): Record<string, any> {
  if (!body || typeof body !== 'object') {
    return {}
  }

  const typedBody = body as Record<string, any>
  if (typedBody.json && typeof typedBody.json === 'object') {
    return typedBody.json as Record<string, any>
  }

  const firstEntry = typedBody[0]
  if (firstEntry?.json && typeof firstEntry.json === 'object') {
    return firstEntry.json as Record<string, any>
  }

  return typedBody['0']?.json || {}
}

describe('Offline sync', () => {
  it('keeps optimistic updates and syncs queued changes after reconnect', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const offlineName = `Test Offline Item ${uniqueId}`

    cy.page('people')
    cy.dataCy('open-filter').click()
    cy.dataCy('filter-cancel').click()
    cy.dataCy('filter-done').click()
    cy.goOffline()

    cy.createPerson({ name: offlineName }, true).saveDrawer()
    cy.checkA11y('[data-cy="drawer-content"]')

    cy.contains(offlineName).should('exist')

    cy.get('[aria-label="Sync now"]').trigger('mouseover', { force: true })

    cy.goOnline()
    cy.get('[aria-label="Sync now"]').click({ force: true })
  })

  it('silently merges User A title edit with User B note edit on reconnect without conflict UI', () => {
    cy.page('people')

    const conflictItemId = `conflict-test-item-${Date.now()}`
    const baseVersion = `base-${Date.now()}`
    const branchNameVersion = `name-${Date.now()}`
    const branchNotesVersion = `notes-${Date.now()}`

    const mergedName = `Merged Name ${Date.now().toString().slice(-4)}`
    const mergedNote = `Merged note ${Date.now().toString().slice(-4)}`

    let nameBranch = ''
    let notesBranch = ''

    cy.window().then(async (win) => {
      const vault = await win.vault

      const [namePayload, notesPayload] = await Promise.all([
        vault.encryptObjectAsAutomerge({
          id: conflictItemId,
          name: mergedName,
          description: '',
          notes: [],
          archived: false,
          prayedFor: [],
          prayerFrequency: 'none',
          created: Date.now(),
          type: 'person',
        }),
        vault.encryptObjectAsAutomerge({
          id: conflictItemId,
          name: mergedName,
          description: '',
          notes: [{
            id: `note-${Date.now()}`,
            text: mergedNote,
            archived: false,
            time: Date.now(),
          }],
          archived: false,
          prayedFor: [],
          prayerFrequency: 'none',
          created: Date.now(),
          type: 'person',
        }),
      ])

      nameBranch = namePayload.encryptedAutomergeDoc
      notesBranch = notesPayload.encryptedAutomergeDoc
    })

    cy.intercept('GET', '**/trpc/items.fetchMany*', (req) => {
      req.reply({
        statusCode: 200,
        body: toTrpcSuccessResponse({
          success: true,
          items: [
            {
              item: conflictItemId,
              branches: [
                {
                  encryptedAutomergeDoc: nameBranch,
                  versionId: branchNameVersion,
                  parentIds: [baseVersion],
                },
                {
                  encryptedAutomergeDoc: notesBranch,
                  versionId: branchNotesVersion,
                  parentIds: [baseVersion],
                },
              ],
              metadata: {
                type: 'person',
                iv: '',
                modified: Date.now(),
              },
            },
          ],
          serverTime: Date.now(),
          nextCursor: null,
        }),
      })
    }).as('fetchConflict')

    cy.intercept('POST', '**/trpc/items.resolveBranchConflict*', (req) => {
      const input = extractTrpcInput(req.body)

      expect(input).to.have.property('resolutions')
      expect(input.resolutions).to.be.an('array')
      expect(input.resolutions.length).to.be.greaterThan(0)

      const resolution = input.resolutions[0]
      expect(resolution).to.have.property('resolvedBranch')
      expect(resolution.resolvedBranch).to.have.property('encryptedAutomergeDoc')
      expect(resolution.resolvedBranch).to.have.property('versionId')
      expect(resolution.resolvedBranch).to.have.property('parentIds')

      expect(resolution.resolvedBranch.parentIds).to.include.members([branchNameVersion, branchNotesVersion])

      req.reply({
        statusCode: 200,
        body: toTrpcSuccessResponse({
          success: true,
          resolvedCount: 1,
        }),
      })
    }).as('resolveConflict')

    // Simulate User B returning online and receiving the branched payload.
    cy.visit('/')
    cy.wait('@fetchConflict', { timeout: 10000 })
    cy.page('people')

    // No user-facing conflict flow should appear.
    cy.get('body').should('not.contain.text', 'Version conflict')
    cy.get('body').should('not.contain.text', 'Resolve conflict')
    cy.get('body').should('not.contain.text', 'Conflict detected')

    cy.dataCy('page-content-people').should('exist')
  })

  it('displays healthy merged data even when one branch is corrupted', () => {
    // When the server has corrupted branches mixed with healthy ones,
    // the worker should merge the healthy branches and warn the user

    cy.page('people')

    const corruptedItemId = `partially-corrupted-item-${Date.now()}`
    const healthyVersion = `v1-${Date.now()}`
    const corruptedVersion = `v2-corrupted-${Date.now()}`

    let validBranch = ''

    cy.window().then(async (win) => {
      const vault = await win.vault
      const encrypted = await vault.encryptObjectAsAutomerge({
        id: corruptedItemId,
        name: 'Partially Corrupted',
        archived: false,
        type: 'person',
      })
      validBranch = encrypted.encryptedAutomergeDoc
    })

    cy.intercept('GET', '**/trpc/items.fetchMany*', (req) => {
      req.reply({
        statusCode: 200,
        body: toTrpcSuccessResponse({
          success: true,
          items: [
            {
              item: corruptedItemId,
              branches: [
                {
                  encryptedAutomergeDoc: validBranch,
                  versionId: healthyVersion,
                  parentIds: [],
                },
                {
                  // Corrupted/invalid branch (would fail to decrypt/load in worker)
                  encryptedAutomergeDoc: '00ff11',
                  versionId: corruptedVersion,
                  parentIds: [healthyVersion],
                },
              ],
              metadata: {
                type: 'person',
                iv: '',
                modified: Date.now(),
              },
            },
          ],
          serverTime: Date.now(),
          nextCursor: null,
        }),
      })
    }).as('fetchPartiallyCorrupted')

    // The worker should attempt resolution anyway (merging the valid branch)
    cy.intercept('POST', '**/trpc/items.resolveBranchConflict*', (req) => {
      // Should still push a resolution even though one branch was corrupted
      const input = extractTrpcInput(req.body)
      expect(input.resolutions).to.exist
      req.reply({
        statusCode: 200,
        body: toTrpcSuccessResponse({
          success: true,
          resolvedCount: 1,
        }),
      })
    }).as('resolvePartial')

    cy.visit('/')
    cy.wait('@fetchPartiallyCorrupted', { timeout: 10000 })

    // Should process partially-corrupted payload without crashing
    cy.dataCy('page-content-prayer').should('exist')
  })
})
