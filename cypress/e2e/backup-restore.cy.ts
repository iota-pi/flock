function toTrpcSuccessResponse(json: unknown, body?: unknown) {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const keys = Object.keys(body as Record<string, unknown>).filter(key => key !== 'json')
    if (keys.length > 0) {
      return keys.map(() => ({
        result: {
          data: {
            json,
          },
        },
      }))
    }
  }

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

describe('Backup and restore', () => {
  it('exports a backup and opens restore dialog', () => {
    cy.page('settings')
    cy.checkA11y()
    cy.dataCy('export').click()
    cy.contains('Backup created').should('be.visible')

    cy.dataCy('restore').click()
    cy.get('[role="dialog"]').should('exist')
    cy.checkA11y('[role="dialog"]')
    cy.get('[data-cy="import-cancel"]').click()
  })

  it('auto-resolves conflicted branches after restore-style hydration', () => {
    const conflictItemId = `backup-conflict-${Date.now()}`
    const versionA = `backup-v1-${Date.now()}`
    const versionB = `backup-v2-${Date.now()}`
    let branchA = ''
    let branchB = ''

    cy.window().then(async (win) => {
      const vault = await win.vault
      const [a, b] = await Promise.all([
        vault.encryptObjectAsAutomerge({
          id: conflictItemId,
          name: 'Backup Merge Person',
          description: 'edited on device A',
          type: 'person',
          archived: false,
          notes: [],
          prayedFor: [],
          prayerFrequency: 'none',
          created: Date.now(),
        }),
        vault.encryptObjectAsAutomerge({
          id: conflictItemId,
          name: 'Backup Merge Person',
          description: 'edited on device B',
          type: 'person',
          archived: false,
          notes: [{ id: `n-${Date.now()}`, text: 'note from B', archived: false, time: Date.now() }],
          prayedFor: [],
          prayerFrequency: 'none',
          created: Date.now(),
        }),
      ])
      branchA = a.encryptedAutomergeDoc
      branchB = b.encryptedAutomergeDoc
    })

    cy.intercept('GET', '**/trpc/items.fetchMany*', (req) => {
      req.reply({
        statusCode: 200,
        body: [{
          result: {
            data: {
              json: {
                success: true,
                items: [{
                  item: conflictItemId,
                  branches: [
                    { encryptedAutomergeDoc: branchA, versionId: versionA, parentIds: [] },
                    { encryptedAutomergeDoc: branchB, versionId: versionB, parentIds: [versionA] },
                  ],
                  metadata: { type: 'person', iv: '', modified: Date.now() },
                }],
                serverTime: Date.now(),
                nextCursor: null,
              },
            },
          },
        }],
      })
    }).as('fetchConflictAfterRestore')

    cy.intercept('POST', '**/trpc/items.resolveBranchConflict*', (req) => {
      const body = req.body as Record<string, any>
      const input = body?.json || body?.[0]?.json || body?.['0']?.json || {}
      expect(input.resolutions?.[0]?.resolvedBranch?.parentIds).to.include.members([versionA, versionB])
      req.reply({
        statusCode: 200,
        body: [{ result: { data: { json: { success: true, resolvedCount: 1 } } } }],
      })
    }).as('resolveConflictAfterRestore')

    cy.page('people')
    cy.location('pathname').should('include', 'people')
  })
})
