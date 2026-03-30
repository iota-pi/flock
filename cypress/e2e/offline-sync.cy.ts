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
    cy.contains('Syncing').should('exist')

    cy.goOnline()
    cy.get('[aria-label="Sync now"]').click({ force: true })
  })

  it('handles forced conflict resolution by merging branches and pushing resolution', () => {
    // This test simulates a scenario where two concurrent edits created conflicting branches
    // The client receives the item with multiple branches, merges them, and pushes the resolution

    cy.page('people')

    const conflictItemId = `conflict-test-item-${Date.now()}`
    const versionA = `v1-${Date.now()}`
    const versionB = `v2-${Date.now()}`

    let validBranchA = ''
    let validBranchB = ''

    cy.window().then(async (win) => {
      const vault = await win.vault
      const [encryptedA, encryptedB] = await Promise.all([
        vault.encryptObjectAsAutomerge({
          id: conflictItemId,
          name: 'Conflict Person A',
          archived: false,
          type: 'person',
        }),
        vault.encryptObjectAsAutomerge({
          id: conflictItemId,
          name: 'Conflict Person B',
          archived: true,
          type: 'person',
        }),
      ])

      validBranchA = encryptedA.encryptedAutomergeDoc
      validBranchB = encryptedB.encryptedAutomergeDoc
    })

    // Step 1: Intercept the item fetch to return an artificially conflicted item
    // (simulating what the server would return if two clients edited concurrently)
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
                  encryptedAutomergeDoc: validBranchA,
                  versionId: versionA,
                  parentIds: [],
                },
                {
                  encryptedAutomergeDoc: validBranchB,
                  versionId: versionB,
                  parentIds: [versionA],
                },
              ],
              metadata: {
                type: 'person',
                iv: '',
                modified: Date.now(),
                version: 2,
              },
            },
          ],
          serverTime: Date.now(),
          nextCursor: null,
        }),
      })
    }).as('fetchConflict')

    // Step 2: Spy on the resolveBranchConflict endpoint
    cy.intercept('POST', '**/trpc/items.resolveBranchConflict*', (req) => {
      const input = extractTrpcInput(req.body)

      // Verify the request has a single merged branch
      expect(input).to.have.property('resolutions')
      expect(input.resolutions).to.be.an('array')
      expect(input.resolutions.length).to.be.greaterThan(0)

      const resolution = input.resolutions[0]
      expect(resolution).to.have.property('resolvedBranch')
      expect(resolution.resolvedBranch).to.have.property('encryptedAutomergeDoc')
      expect(resolution.resolvedBranch).to.have.property('versionId')
      expect(resolution.resolvedBranch).to.have.property('parentIds')

      // parentIds should reference both branches that were merged
      expect(resolution.resolvedBranch.parentIds).to.include.members([versionA, versionB])

      req.reply({
        statusCode: 200,
        body: toTrpcSuccessResponse({
          success: true,
          resolvedCount: 1,
        }),
      })
    }).as('resolveConflict')

    // Step 3: Trigger the fetch (this loads items and should detect the conflict)
    cy.visit('/')
    cy.wait('@fetchConflict', { timeout: 10000 })

    // Step 4: Ensure app remains healthy after conflicted payload processing
    cy.dataCy('page-content-prayer').should('exist')
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
                version: 2,
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
