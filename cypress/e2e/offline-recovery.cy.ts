function createFailedMutation(itemName: string, description: string) {
  cy.page('people')
  cy.createPerson({ name: itemName }, true)
  cy.dataCy('drawer-done').last().click()

  cy.contains(itemName).click()
  cy.dataCy('add-description').last().click()
  cy.dataCy('description').last().clear().type(description)

  cy.forceServerError()
  cy.dataCy('drawer-done').last().click()
  cy.wait('@errorPut')
}

describe('Offline recovery', () => {
  it('routes failed saves to DLQ and supports discard/retry recovery flows', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const itemName = `DLQ Person ${uniqueId}`
    const firstDescription = `failed-description-${uniqueId}`

    createFailedMutation(itemName, firstDescription)

    cy.contains('moved to recovery queue').should('be.visible')
    cy.get('[data-cy="page-settings"] .MuiBadge-badge').should('contain', '1')

    cy.page('settings')
    cy.contains('Offline data recovery').should('be.visible').click()
    cy.contains('Offline Data Recovery').should('be.visible')
    cy.contains('button', 'Retry').should('have.length', 1)

    cy.contains('button', 'Discard').click()
    cy.contains('No offline recovery actions are required right now.').should('be.visible')
    cy.page('prayer')
    cy.get('[data-cy="page-settings"] .MuiBadge-badge').should('not.exist')

    const retryDescription = `retry-description-${uniqueId}`
    createFailedMutation(itemName, retryDescription)

    cy.page('settings')
    cy.contains('Offline data recovery').should('be.visible').click()

    cy.goOnline()
    cy.contains('button', 'Retry').click()
    cy.get('.MuiCircularProgress-root').should('exist')
    cy.contains('No offline recovery actions are required right now.').should('be.visible')

    cy.get('[data-cy="import-cancel"]').click()
    cy.page('people')
    cy.contains(itemName).click()
    cy.dataCy('description').last().should('have.value', retryDescription)
  })
})
