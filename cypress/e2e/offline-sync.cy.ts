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

    cy.contains(offlineName).should('exist')

    cy.get('[aria-label="Sync now"]').trigger('mouseover', { force: true })
    cy.contains('Syncing').should('exist')

    cy.goOnline()
    cy.get('[aria-label="Sync now"]').click({ force: true })
  })
})
