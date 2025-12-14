describe('Prayer flows', () => {
  beforeEach(() => {
    cy.visit('/')
  })

  it('sets prayer frequencies and verifies ordering on prayer page', () => {
    // Test deleting everything which also ensures a clean prayer schedule
    cy.page('people')
    cy.createPerson({ name: 'Linden' })
      .saveDrawer()
    cy.dataCy('select-all').click()
    cy.dataCy('action-delete').click()
    cy.dataCy('confirm-confirm').click()

    // Create people with different prayer frequencies
    cy.createPerson({ name: 'Athelas' })
    cy.createPerson({ name: 'Mallorn', prayerFrequency: 'annually' })
    cy.createPerson({ name: 'One Ring', prayerFrequency: 'daily' })
      .saveDrawer()

    // Assign prayer frequency through bulk selection actions
    cy.dataCy('list-item-checkbox').first().click()
    cy.dataCy('action-frequency').click()
    cy.dataCy('dialog-frequency').click()
    cy.dataCy('frequency-weekly').click()
    cy.dataCy('dialog-confirm').click()

    // Verify ordering on prayer page
    cy.page('prayer')
    cy.dataCy('edit-goal').click()
    cy.dataCy('dialog-goal-input').clear().type('5')
    cy.dataCy('dialog-confirm').click()
    cy.dataCy('list-item').eq(0).contains('One Ring')
    cy.dataCy('list-item').eq(1).contains('Athelas')
    cy.dataCy('list-item').eq(2).contains('Mallorn')
    cy.dataCy('list-item').contains('Linden').should('not.exist')
  })
})
