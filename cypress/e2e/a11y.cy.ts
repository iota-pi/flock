describe('Accessibility Audits', () => {
  it('item page', () => {
    cy.page('people')
    cy.checkA11y()
  })

  it('person drawer', () => {
    cy.page('people')
    cy.dataCy('fab').click({ force: true })
    cy.checkA11y('[data-cy="drawer-content"]')
  })

  it('prayer page', () => {
    cy.page('prayer')
    cy.checkA11y()
  })

  it('goal dialog', () => {
    cy.page('prayer')
    cy.dataCy('edit-goal').click()
    cy.checkA11y('[role="dialog"]')
  })

  it('settings page', () => {
    cy.page('settings')
    cy.checkA11y()
  })
})
