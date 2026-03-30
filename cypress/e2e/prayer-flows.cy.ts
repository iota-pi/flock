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
    cy.dataCy('list-item').then($rows => {
      const names = Array.from($rows, row => row.textContent || '')
      const oneRingIndex = names.findIndex(text => text.includes(oneRingName))
      const mallornIndex = names.findIndex(text => text.includes(mallornName))
      const athelasIndex = names.findIndex(text => text.includes(athelasName))

      expect(oneRingIndex).to.be.greaterThan(-1)
      expect(mallornIndex).to.be.greaterThan(-1)
      expect(athelasIndex).to.be.greaterThan(-1)
      expect(oneRingIndex).to.be.lessThan(mallornIndex)
    })
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
