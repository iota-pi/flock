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

function generateMockEncryptedDoc(): string {
  const randomBytes = Math.random().toString(36).substring(2) + Math.random().toString(36).substring(2)
  return Buffer.from(randomBytes).toString('base64')
}

describe('Backup and restore', () => {
  it('exports a backup and opens restore dialog', () => {
    cy.page('settings')
    cy.dataCy('export').click()
    cy.contains('Backup created').should('be.visible')

    cy.dataCy('restore').click()
    cy.get('[role="dialog"]').should('exist')
    cy.get('[data-cy="import-cancel"]').click()
  })

  it('auto-resolves conflicted branches after restore-style hydration', () => {
    const conflictItemId = `backup-conflict-${Date.now()}`
    const versionA = `backup-v1-${Date.now()}`
    const versionB = `backup-v2-${Date.now()}`
    const branchA = generateMockEncryptedDoc()
    const branchB = generateMockEncryptedDoc()

    cy.intercept('GET', '**/trpc/items.fetchManifest*', (req) => {
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
                    { doc: branchA, versionId: versionA, parentIds: [] },
                    { doc: branchB, versionId: versionB, parentIds: [versionA] },
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
