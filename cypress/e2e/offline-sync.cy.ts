describe('Offline sync', () => {
  it('keeps local item creation visible across reconnect', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const offlineName = `Offline Person ${uniqueId}`

    cy.page('people')
    cy.goOffline()

    cy.createPerson({ name: offlineName }, true).saveDrawer()
    cy.contains(offlineName).should('exist')

    cy.goOnline()
    cy.get('[aria-label="Sync now"]').click({ force: true })
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
    cy.get('[aria-label="Sync now"]').click({ force: true })

    cy.contains(updatedName).should('exist')
    cy.get('body').should('not.contain.text', 'Version conflict')
    cy.get('body').should('not.contain.text', 'Resolve conflict')
    cy.get('body').should('not.contain.text', 'Conflict detected')
  })

  it('keeps people page usable after manual sync trigger', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const seededName = `Pull Error Person ${uniqueId}`

    cy.page('people')
    cy.createPerson({ name: seededName }, true).saveDrawer()

    cy.get('[aria-label="Sync now"]').click({ force: true })

    cy.dataCy('page-content-people').should('exist')
    cy.contains(seededName).should('exist')
  })
})
