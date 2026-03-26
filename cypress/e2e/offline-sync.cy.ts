describe('Offline sync', () => {
  it('keeps optimistic updates and syncs queued changes after reconnect', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const offlineName = `Test Offline Item ${uniqueId}`

    cy.page('people')
    cy.goOffline()

    cy.dataCy('fab').click()
    cy.dataCy('name').clear().type(offlineName)
    cy.dataCy('drawer-done').last().click()

    cy.contains(offlineName).should('exist')
    cy.getOfflineQueue().should(queue => {
      expect(queue.length).to.be.greaterThan(0)
    })

    cy.get('[aria-label="Sync now"]').trigger('mouseover', { force: true })
    cy.contains('Syncing (1 queued)').should('exist')

    cy.goOnline()
    cy.get('[aria-label="Sync now"]').click({ force: true })

    cy.getOfflineQueue().should('have.length', 0)

    cy.reload()
    cy.page('people')
    cy.contains(offlineName).should('exist')
  })
})
