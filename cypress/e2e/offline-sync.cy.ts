describe('Offline sync', () => {
  it('handles offline creation and edits across reconnect without conflicts', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const offlineName = `Offline Person ${uniqueId}`
    const initialName = `Reconnect Person ${uniqueId}`
    const updatedName = `${initialName} Updated`

    // Programmatically seed initial person while online
    cy.createPerson({ name: initialName })
    cy.page('people')
    cy.contains(initialName).should('exist')

    // Go offline
    cy.goOffline()

    // 1. Test manual creation while offline
    cy.createPerson({ name: offlineName }, true).saveDrawer()
    cy.contains(offlineName).should('exist')

    // 2. Test edit while offline
    cy.contains(initialName).click()
    cy.dataCy('name').clear().type(updatedName)
    cy.saveDrawer()
    cy.contains(updatedName).should('exist')

    // Go online & verify automatic sync
    cy.goOnline()
    cy.contains(offlineName).should('exist')
    cy.contains(updatedName).should('exist')
    cy.get('body').should('not.contain.text', 'Version conflict')
    cy.get('body').should('not.contain.text', 'Resolve conflict')
    cy.get('body').should('not.contain.text', 'Conflict detected')
  })
})
