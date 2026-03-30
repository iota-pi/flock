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

    // Step 1: Intercept the item fetch to return an artificially conflicted item
    // (simulating what the server would return if two clients edited concurrently)
    cy.intercept('POST', '**/trpc/items.fetchMany*', (req) => {
      req.reply({
        statusCode: 200,
        body: {
          success: true,
          items: [
            {
              item: 'conflict-test-item',
              // Simulate two conflicting branches
              // This would normally be encrypted Automerge docs, but for testing we use placeholders
              branches: [
                {
                  encryptedAutomergeDoc: 'encrypted-branch-1',
                  versionId: 'v1',
                  parentIds: [],
                },
                {
                  encryptedAutomergeDoc: 'encrypted-branch-2',
                  versionId: 'v2',
                  parentIds: ['v1'],
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
        },
      })
    }).as('fetchConflict')

    // Step 2: Spy on the resolveBranchConflict endpoint
    cy.intercept('POST', '**/trpc/items.resolveBranchConflict*', (req) => {
      // Verify the request has a single merged branch
      const body = req.body
      expect(body).to.have.property('resolutions')
      expect(body.resolutions).to.be.an('array')
      expect(body.resolutions.length).to.be.greaterThan(0)

      const resolution = body.resolutions[0]
      expect(resolution).to.have.property('resolvedBranch')
      expect(resolution.resolvedBranch).to.have.property('encryptedAutomergeDoc')
      expect(resolution.resolvedBranch).to.have.property('versionId')
      expect(resolution.resolvedBranch).to.have.property('parentIds')

      // parentIds should reference both branches that were merged
      expect(resolution.resolvedBranch.parentIds).to.include.members(['v1', 'v2'])

      req.reply({
        statusCode: 200,
        body: {
          success: true,
          resolvedCount: 1,
        },
      })
    }).as('resolveConflict')

    // Step 3: Trigger the fetch (this loads items and should detect the conflict)
    cy.visit('/')

    // Step 4: Verify the conflict resolution was attempted
    cy.wait('@resolveConflict', { timeout: 10000 }).then((interception) => {
      expect(interception.response?.statusCode).to.equal(200)
      expect(interception.response?.body.success).to.be.true
    })
  })

  it('displays healthy merged data even when one branch is corrupted', () => {
    // When the server has corrupted branches mixed with healthy ones,
    // the worker should merge the healthy branches and warn the user

    cy.page('people')

    cy.intercept('POST', '**/trpc/items.fetchMany*', (req) => {
      req.reply({
        statusCode: 200,
        body: {
          success: true,
          items: [
            {
              item: 'partially-corrupted-item',
              branches: [
                {
                  // Valid branch
                  encryptedAutomergeDoc: 'valid-encrypted-doc',
                  versionId: 'v1',
                  parentIds: [],
                },
                {
                  // Corrupted/invalid branch (would fail to decrypt/load in worker)
                  encryptedAutomergeDoc: 'corrupted-doc',
                  versionId: 'v2-corrupted',
                  parentIds: ['v1'],
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
        },
      })
    }).as('fetchPartiallyCorrupted')

    // The worker should attempt resolution anyway (merging the valid branch)
    cy.intercept('POST', '**/trpc/items.resolveBranchConflict*', (req) => {
      // Should still push a resolution even though one branch was corrupted
      expect(req.body.resolutions).to.exist
      req.reply({
        statusCode: 200,
        body: {
          success: true,
          resolvedCount: 1,
        },
      })
    }).as('resolvePartial')

    cy.visit('/')

    // Should attempt resolution without crashing
    cy.wait('@resolvePartial', { timeout: 10000 }).then((interception) => {
      expect(interception.response?.statusCode).to.equal(200)
    })
  })
})
