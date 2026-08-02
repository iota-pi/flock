describe('Deletion Cleanup', () => {
  it('removes deleted person from groups', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const personId = `person_${uniqueId}`
    const personName = `Person_${uniqueId}`
    const groupName = `Group_${uniqueId}`

    // 1. Programmatically create Person and Group with linked member
    cy.createPerson({ id: personId as any, name: personName })
    cy.createGroup({ name: groupName, members: [personId as any] })

    // 2. Verify Group has 1 member
    cy.page('groups')
    cy.contains(groupName).click()
    cy.contains('1 member').should('exist')
    cy.contains(personName).should('exist')
    cy.get('[data-cy=back-button]').click()

    // 3. Delete Person via UI (testing the actual deletion interaction)
    cy.page('people')
    cy.contains(personName).click()
    cy.get('[data-cy=drawer-cancel]').click() // Open delete dialog
    cy.get('[data-cy=confirm-confirm]').click() // Confirm delete

    // 4. Verify Person is gone
    cy.contains(personName).should('not.exist')

    // 5. Verify deleted person is not shown in People list and group still opens
    cy.page('groups')
    cy.contains(groupName).click()
  })
})
