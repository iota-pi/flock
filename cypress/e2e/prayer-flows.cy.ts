describe('Prayer flows', () => {
  it('manages prayer goals and runs an active prayer session', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const lindenName = `Linden_${uniqueId}`
    const athelasName = `Athelas_${uniqueId}`
    const mallornName = `Mallorn_${uniqueId}`
    const itemA = `PrayerA_${uniqueId}`
    const itemB = `PrayerB_${uniqueId}`
    const itemC = `PrayerC_${uniqueId}`

    // Seed people with explicit frequencies programmatically
    cy.createPerson({ name: lindenName, prayerFrequency: 'none' })
    cy.createPerson({ name: athelasName, prayerFrequency: 'weekly' })
    cy.createPerson({ name: mallornName, prayerFrequency: 'annually' })
    cy.createPerson({ name: itemA, prayerFrequency: 'daily' })
    cy.createPerson({ name: itemB, prayerFrequency: 'daily' })
    cy.createPerson({ name: itemC, prayerFrequency: 'daily' })

    // 1. Verify prayer goal editing
    cy.dataCy('page-prayer').click({ force: true })
    cy.location('pathname').should('equal', '/')
    cy.dataCy('edit-goal').should('exist')
    cy.dataCy('edit-goal').click()
    cy.dataCy('dialog-goal-input').clear().type('5')
    cy.dataCy('dialog-confirm').click()
    cy.dataCy('list-item').should('have.length.greaterThan', 0)
    cy.dataCy('start-prayer').should('exist')

    // 2. Run active prayer session
    cy.contains(itemA).should('be.visible')
    cy.contains('button', /^Start$/i).last().click({ force: true })

    cy.dataCy('page-content-prayer').should('exist')
    cy.contains(itemA).should('exist')
    cy.contains(itemB).should('exist')
    cy.contains(itemC).should('exist')
  })
})
