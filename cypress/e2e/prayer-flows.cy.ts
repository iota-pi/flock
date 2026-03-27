describe('Prayer flows', () => {
  function goToPeoplePage() {
    cy.get('body').then($body => {
      if ($body.find('[data-cy="page-people"]').length === 0) {
        cy.reload()
      }
    })

    cy.injectAxe()
    cy.get('[data-cy="page-people"]', { timeout: 20000 }).click({ force: true })
    cy.location('pathname').should('equal', '/people')
  }

  it('sets prayer frequencies and verifies ordering on prayer page', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const lindenName = `Linden_${uniqueId}`
    const athelasName = `Athelas_${uniqueId}`
    const mallornName = `Mallorn_${uniqueId}`
    const oneRingName = `One Ring_${uniqueId}`

    // Test deleting everything which also ensures a clean prayer schedule
    goToPeoplePage()
    cy.createPerson({ name: lindenName, prayerFrequency: 'daily' })
    cy.invalidateQuery('items')
    cy.dataCy('select-all').click()
    cy.dataCy('action-delete').click()
    cy.dataCy('confirm-confirm').click()

    // Create people with different prayer frequencies
    cy.createPerson({ name: athelasName })
    cy.createPerson({ name: mallornName, prayerFrequency: 'annually' })
    cy.createPerson({ name: oneRingName, prayerFrequency: 'daily' })
    cy.invalidateQuery('items')

    // Assign prayer frequency through bulk selection actions
    cy.dataCy('list-item-checkbox').first().click()
    cy.dataCy('action-frequency').click()
    cy.dataCy('dialog-frequency').click()
    cy.dataCy('frequency-weekly').click()
    cy.dataCy('dialog-confirm').click()

    // Verify ordering on prayer page
    cy.dataCy('page-prayer').click({ force: true })
    cy.location('pathname').should('equal', '/')
    cy.dataCy('edit-goal').should('exist')
    cy.dataCy('edit-goal').click()
    cy.checkA11y('[role="dialog"]')
    cy.dataCy('dialog-goal-input').clear().type('5')
    cy.dataCy('dialog-confirm').click()
    cy.dataCy('list-item').eq(0).contains(oneRingName)
    cy.dataCy('list-item').contains(mallornName).should('exist')
    cy.dataCy('list-item').contains(lindenName).should('not.exist')
  })

  it('runs an active prayer session from start to completion and persists prayer updates', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const itemA = `PrayerA_${uniqueId}`
    const itemB = `PrayerB_${uniqueId}`
    const itemC = `PrayerC_${uniqueId}`

    goToPeoplePage()
    cy.get('body').then($body => {
      if ($body.find('[data-cy="list-item"]').length > 0) {
        cy.dataCy('select-all').click()
        cy.dataCy('action-delete').click()
        cy.dataCy('confirm-confirm').click()
      }
    })

    cy.createPerson({ name: itemA, prayerFrequency: 'daily' })
    cy.createPerson({ name: itemB, prayerFrequency: 'daily' })
    cy.createPerson({ name: itemC, prayerFrequency: 'daily' })
    cy.invalidateQuery('items')

    cy.dataCy('page-prayer').click({ force: true })
    cy.location('pathname').should('equal', '/')
    cy.contains(itemA).should('be.visible')
    cy.dataCy('start-prayer').click()
    cy.checkA11y('[data-cy="drawer-content"]')

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

    cy.getOfflineQueue().should('have.length', 0)
  })
})
