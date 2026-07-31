describe('Offline sync', () => {
  it('keeps local item creation visible across reconnect', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const offlineName = `Offline Person ${uniqueId}`

    cy.page('people')
    cy.goOffline()

    cy.createPerson({ name: offlineName }, true).saveDrawer()
    cy.contains(offlineName).should('exist')

    cy.goOnline()
    // Wait for the automatic sync to occur and assert the item is still there
    cy.contains(offlineName).should('exist')
  })

  it('preserves local edits after reconnect without showing conflict prompts', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const initialName = `Reconnect Person ${uniqueId}`
    const updatedName = `${initialName} Updated`

    cy.page('people')
    cy.createPerson({ name: initialName }, true).saveDrawer()
    cy.contains(initialName).should('exist')

    cy.goOffline()
    cy.contains(initialName).click()
    cy.dataCy('name').clear().type(updatedName)
    cy.saveDrawer()

    cy.contains(updatedName).should('exist')

    cy.goOnline()
    // Wait for the automatic sync to occur
    cy.contains(updatedName).should('exist')
    cy.get('body').should('not.contain.text', 'Version conflict')
    cy.get('body').should('not.contain.text', 'Resolve conflict')
    cy.get('body').should('not.contain.text', 'Conflict detected')
  })
})
