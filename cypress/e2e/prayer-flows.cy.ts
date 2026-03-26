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

  it('runs an active prayer session from start to completion and persists prayer updates', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const itemA = `PrayerA_${uniqueId}`
    const itemB = `PrayerB_${uniqueId}`
    const itemC = `PrayerC_${uniqueId}`

    cy.page('people')
    cy.createPerson({ name: itemA, prayerFrequency: 'daily' })
    cy.createPerson({ name: itemB, prayerFrequency: 'daily' })
    cy.createPerson({ name: itemC, prayerFrequency: 'daily' })
    cy.invalidateQuery('items')

    cy.page('prayer')
    cy.dataCy('start-prayer').click()

    cy.dataCy('item-name').should('contain.text', itemA)
    cy.dataCy('prayer-step-0').should('have.attr', 'data-state', 'active')

    cy.intercept('POST', '**/trpc/items.put*').as('prayerPut')

    cy.contains('button', 'Next').click()
    cy.dataCy('item-name').should('contain.text', itemB)
    cy.dataCy('prayer-step-0').should('have.attr', 'data-state', 'complete')
    cy.dataCy('prayer-step-1').should('have.attr', 'data-state', 'active')

    cy.contains('button', 'Next').click()
    cy.dataCy('item-name').should('contain.text', itemC)

    cy.contains('button', 'Finish').click()
    cy.contains('All done!').should('be.visible')
    cy.contains('You prayed for').should('be.visible')

    cy.contains('button', 'Back to Overview').click()
    cy.dataCy('start-prayer').should('be.disabled')

    cy.wait('@prayerPut').its('request.body').should('exist')
    cy.wait('@prayerPut').its('request.body').should('exist')
    cy.wait('@prayerPut').its('request.body').should('exist')

    cy.getOfflineQueue().should('have.length', 0)
  })
})
