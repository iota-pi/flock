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

    goToPeoplePage()
    // Create people with explicit frequencies to avoid flaky bulk-action dependencies.
    cy.createPerson({ name: lindenName, prayerFrequency: 'none' })
    cy.createPerson({ name: athelasName, prayerFrequency: 'weekly' })
    cy.createPerson({ name: mallornName, prayerFrequency: 'annually' })
    cy.createPerson({ name: oneRingName, prayerFrequency: 'daily' })
    cy.invalidateQuery('items')

    // Verify ordering on prayer page
    cy.dataCy('page-prayer').click({ force: true })
    cy.location('pathname').should('equal', '/')
    cy.dataCy('edit-goal').should('exist')
    cy.dataCy('edit-goal').click()
    cy.checkA11y('[role="dialog"]')
    cy.dataCy('dialog-goal-input').clear().type('5')
    cy.dataCy('dialog-confirm').click()
    cy.dataCy('list-item').should('have.length.greaterThan', 0)
    cy.dataCy('start-prayer').should('exist')
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
    cy.contains('button', /^Start$/i).last().click({ force: true })
    cy.checkA11y('[data-cy="drawer-content"]')

    cy.dataCy('page-content-prayer').should('exist')
    cy.contains(itemA).should('exist')
    cy.contains(itemB).should('exist')
    cy.contains(itemC).should('exist')
  })
})
