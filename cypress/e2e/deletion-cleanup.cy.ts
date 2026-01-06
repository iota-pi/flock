describe('Deletion Cleanup', () => {
  it('removes deleted person from groups', () => {
    const uniqueId = Date.now().toString().slice(-6)
    const personName = `Person_${uniqueId}`
    const groupName = `Group_${uniqueId}`

    // 1. Create Person
    cy.createPerson({ name: personName }, true).saveDrawer()

    // 2. Create Group and add Person
    cy.createGroup({ name: groupName }, true)
      .addMember(personName)
      .saveDrawer()

    // 3. Verify Group has 1 member
    cy.page('groups')
    cy.contains(groupName).click()
    cy.contains('1 member').should('exist')
    cy.contains(personName).should('exist')
    cy.get('[data-cy=back-button]').click()

    // 4. Delete Person
    cy.page('people')
    cy.contains(personName).click()
    cy.get('[data-cy=drawer-cancel]').click() // Open delete dialog
    cy.get('[data-cy=confirm-confirm]').click() // Confirm delete

    // 5. Verify Person is gone
    cy.contains(personName).should('not.exist')

    // 6. Verify Group has 0 members
    cy.page('groups')
    cy.contains(groupName).click()
    cy.contains('0 members').should('exist')
    cy.contains(personName).should('not.exist')
  })
})
