describe('Drawer behavior', () => {
  it('allows switching between stacked and base drawers', () => {
    const uniqueId = Date.now().toString().slice(-6, -2)
    const bilboName = `Bilbo Baggins_${uniqueId}`
    const frodoName = `Frodo Baggins_${uniqueId}`
    const fellowshipName = `Fellowship_${uniqueId}`

    cy.page('people')
    cy.createGroup({ name: fellowshipName })
    cy.createPerson({ name: bilboName, prayerFrequency: 'daily' })
    cy.createPerson({ name: frodoName })

    cy.page('people')
    cy.contains(frodoName).click()
    cy.dataCy('section-groups').click()
    cy.addToGroup(fellowshipName)

    cy.contains(fellowshipName).click()
    cy.dataCy('add-description').last().click()
    cy.dataCy('description').last().type('9v9')
    cy.dataCy('memberPrayerFrequency').last().click()
    cy.dataCy('frequency-weekly').click()
    cy.dataCy('section-members').contains(frodoName).click()
    cy.saveDrawer()

    cy.contains(bilboName).click()
    cy.page('prayer')
    cy.dataCy('page-content-prayer').contains(bilboName).click()
    cy.contains(frodoName).click()
    cy.dataCy('drawer-content').first().contains(bilboName).should('not.exist')
  })
})
