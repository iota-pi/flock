describe('Drawer behavior', () => {
  it('allows switching between drawers', () => {
    const uniqueId = Date.now().toString().slice(-6, -2)
    const bilboName = `Bilbo Baggins_${uniqueId}`
    const frodoName = `Frodo Baggins_${uniqueId}`
    const fellowshipName = `Fellowship_${uniqueId}`

    cy.page('people')
    cy.createGroup({ name: fellowshipName })
    cy.createPerson({ name: bilboName, prayerFrequency: 'daily' })
    cy.createPerson({ name: frodoName })

    cy.contains(frodoName).click()
    cy.dataCy('section-groups').click()
    cy.addToGroup(fellowshipName)

    cy.contains(fellowshipName).click()
    cy.dataCy('add-description').click()
    cy.dataCy('description').type('9v9')
    cy.dataCy('memberPrayerFrequency').click()
    cy.dataCy('frequency-weekly').click()
    cy.dataCy('section-members').contains(frodoName).click()
    cy.saveDrawer()

    cy.contains(bilboName).click()
    cy.dataCy('name').should('have.value', bilboName)
    cy.page('prayer')
    cy.dataCy('page-content-prayer').contains(bilboName).click()
    cy.dataCy('item-name').should('contain.text', bilboName)
  })
})
