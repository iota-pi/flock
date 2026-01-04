describe('Prayer flows', () => {
  it('sets prayer frequencies and verifies ordering on prayer page', () => {
    // Test deleting everything which also ensures a clean prayer schedule
    cy.page('people')
    cy.createPerson({ name: 'Linden', prayerFrequency: 'daily' })
    cy.invalidateQuery('items')
    cy.dataCy('select-all').click()
    cy.dataCy('action-delete').click()
    cy.dataCy('confirm-confirm').click()

    // Create people with different prayer frequencies
    cy.createPerson({ name: 'Athelas' })
    cy.createPerson({ name: 'Mallorn', prayerFrequency: 'annually' })
    cy.createPerson({ name: 'One Ring', prayerFrequency: 'daily' })
    cy.invalidateQuery('items')

    // Assign prayer frequency through bulk selection actions
    cy.dataCy('list-item-checkbox').first().click()
    cy.dataCy('action-frequency').click()
    cy.dataCy('dialog-frequency').click()
    cy.dataCy('frequency-weekly').click()
    cy.dataCy('dialog-confirm').click()

    // Groups page should not contain any groups with members
    cy.page('groups')
    cy.contains('1 member').should('not.exist')
    cy.contains('2 members').should('not.exist')
    cy.contains('3 members').should('not.exist')
    cy.contains('4 members').should('not.exist')
    cy.contains('5 members').should('not.exist')

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
