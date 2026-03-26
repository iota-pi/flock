describe('Filtering and sorting worker integration', () => {
  it('filters and sorts item results through worker-backed flows', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const groupishNames = ['GroupWorker_A', 'GroupWorker_B', 'GroupWorker_C', 'GroupWorker_D', 'GroupWorker_E']
      .map(name => `${name}_${uniqueId}`)
    const personNames = ['PersonWorker_A', 'PersonWorker_B', 'PersonWorker_C', 'PersonWorker_D', 'PersonWorker_E']
      .map(name => `${name}_${uniqueId}`)

    cy.page('people')

    groupishNames.forEach(name => {
      cy.createPerson({ name })
    })
    personNames.forEach(name => {
      cy.createPerson({ name })
    })
    cy.invalidateQuery('items')

    cy.dataCy('open-filter').click()
    cy.dataCy('filter-criterion-name').first().click()
    cy.get('li[role="option"]').contains('Name').click()
    cy.dataCy('filter-criterion-operation').first().click()
    cy.get('li[role="option"]').contains('Contains').click()
    cy.dataCy('filter-criterion-value').first().clear().type('GroupWorker_')
    cy.dataCy('filter-done').click()

    cy.dataCy('list-item').should('have.length', 5)
    personNames.forEach(name => {
      cy.contains(name).should('not.exist')
    })

    cy.dataCy('open-sort').click()
    cy.dataCy('sort-criterion-name').first().click()
    cy.get('li[role="option"]').contains('Name').click()
    cy.dataCy('sort-criterion-order').first().click()
    cy.get('li[role="option"]').contains('Descending').click()
    cy.dataCy('sort-done').click()

    cy.dataCy('list-item').eq(0).invoke('text').then(firstText => {
      cy.dataCy('list-item').eq(1).invoke('text').then(secondText => {
        expect(firstText.trim().localeCompare(secondText.trim())).to.be.greaterThan(0)
      })
    })
  })
})
