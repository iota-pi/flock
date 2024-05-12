describe('Maturity-related functionality', () => {
  beforeEach(() => {
    cy.visit('/')
    cy.createAccount('fnG8iv4t!%Qa')
  })

  it('apply default maturity levels and edit maturity settings', () => {
    cy.createPerson({ name: 'Frodo Baggins' })
    cy.dataCy('maturity-selection')
      .click()
    cy.contains(/non-Christian/i)
      .click()
      .saveDrawer()
    cy.page('settings')
    cy.dataCy('maturity-stages')
      .find('[data-cy=edit-button]')
      .click()

    // Check order swapping
    cy.dataCy('maturity-move-up').first()
      .should('be.disabled')
    cy.dataCy('maturity-move-down').last()
      .should('be.disabled')
    cy.dataCy('maturity-move-down').eq(1)
      .click()
    cy.dataCy('maturity-move-up').eq(1)
      .click()
    cy.dataCy('maturity-stage-name').find('input').first()
      .should('have.value', 'Mature Christian')
    cy.dataCy('maturity-stage-name').find('input').last()
      .should('have.value', 'Young Christian')

    // Remove, add, and edit some stages
    cy.dataCy('maturity-remove-stage')
      .eq(1).click()
    cy.dataCy('maturity-add-stage').click()
    cy.dataCy('maturity-stage-name').last()
      .find('input').should('be.focused')
      .type('Partner')
    cy.dataCy('maturity-stage-name').first()
      .clear()
      .type('Attended')
    cy.dataCy('maturity-stage-name').eq(1)
      .clear()
      .type('Regular')
    cy.dataCy('maturity-done').click()
    cy.dataCy('page-content-settings').contains('Christian').should('not.exist')

    // Previous maturity selection should not exist
    cy.page('people')
    cy.contains('Frodo').click()
    cy.dataCy('maturity-selection').find('input').should('have.value', '')

    // Choose one of the new maturity values
    cy.dataCy('maturity-selection').click()
    cy.contains('Non-Christian').should('not.exist')
    cy.contains('Partner').click()
  })
})
