describe('Items and groups', () => {
  it('creates people and groups, links members, and removes a member', () => {
    const uniqueId = Date.now().toString().slice(-6, -2)
    const frodoName = `Frodo_${uniqueId}`
    const samwiseName = `Samwise_${uniqueId}`
    const merryName = `Merry_${uniqueId}`
    const fellowshipName = `Fellowship_${uniqueId}`

    cy.createPerson({ name: frodoName }, true).saveDrawer()
    cy.createPerson({ name: samwiseName })
    cy.createPerson({ name: merryName })
    cy.invalidateQuery('items')

    cy.createGroup({ name: fellowshipName }, true)
      .addMember(frodoName)
      .addMember(samwiseName)
      .addMember(merryName)
      .saveDrawer()

    cy.page('groups')
    cy.contains(fellowshipName).click()
    cy.contains(samwiseName)
      .parentsUntil('[data-cy=list-item]')
      .parent()
      .find('[data-cy=list-item-action]')
      .click()
      .saveDrawer()

    cy.contains('2 members').should('exist')
  })
})
