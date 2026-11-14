type TrpcBatchResponse = Array<{ result?: { data?: { json?: unknown } | unknown } }>

/** Returns the procedure's result from a batched tRPC response, whether or not it's transformer-wrapped */
function trpcResult<T>(body: TrpcBatchResponse): T {
  const data = body[0]?.result?.data as { json?: T } | T
  return (data && typeof data === 'object' && 'json' in data ? data.json : data) as T
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

  it('fetches items the server lists that this device does not have', () => {
    const missingItemId = `restored-item-${Date.now()}`

    // Pass the real manifest through, adding an item this device has never seen
    cy.intercept('POST', '**/trpc/items.fetchManifest*', req => {
      req.continue(res => {
        const result = trpcResult<{ manifest: Array<Record<string, unknown>> }>(res.body as TrpcBatchResponse)
        result.manifest.push({ itemId: missingItemId, version: 1, modifiedAt: Date.now() })
      })
    }).as('fetchManifest')
    cy.intercept('POST', '**/trpc/items.fetchSnapshotsByIds*').as('fetchSnapshots')

    cy.page('settings')
    cy.dataCy('force-sync').click()

    cy.wait('@fetchManifest')
    cy.wait('@fetchSnapshots').then(interception => {
      const body = interception.request.body as Record<string, { json?: { itemIds?: string[] } }>
      const input = body['0']?.json ?? body['0'] as { itemIds?: string[] }
      expect(input?.itemIds).to.include(missingItemId)
    })

    cy.page('people')
    cy.dataCy('page-content-people').should('exist')
  })
})
