import type { GroupItem, PersonItem } from '../../src/state/items'

Cypress.Commands.add('dataCy', (...dataCy: string[]) => (
  cy.get(dataCy.map(id => `[data-cy="${id}"]`).join(','))
))

Cypress.Commands.add('ensureAccount', (password: string): Cypress.Chainable<string> => {
  const existing = Cypress.env('TEST_ACCOUNT_ID') as string | undefined
  if (existing) {
    return cy.wrap(existing, { log: false })
  }

  cy.visit('/')
  cy.createAccount(password)

  cy.location('pathname').should('equal', '/')

  return cy
    .window()
    .its('localStorage')
    .invoke('getItem', 'FlockVaultAccount')
    .should('be.a', 'string')
    .then(accountId => {
      if (!accountId) throw new Error('Account ID not found after account creation')
      Cypress.env('TEST_ACCOUNT_ID', accountId)
      return accountId
    })
})

Cypress.Commands.add('createAccount', (password: string): Cypress.Chainable => {
  cy.dataCy('create-account').click()
  cy.get('#password').type(password)
  cy.dataCy('create-account').click()
  cy.dataCy('acknowledge-account-id').check({ force: true })
  cy.dataCy('continue-button').click()
  cy.get('#current-password').type(password)
  cy.intercept({ method: 'GET', url: '**/*' }).as('initialFetch')
  cy.dataCy('login').click()
  cy.wait('@initialFetch')
  return cy
})

Cypress.Commands.add(
  'page',
  (page: string): Cypress.Chainable => {
    cy.dataCy(`page-${page}`).click({ force: true })
    const expectedPath = page === 'prayer' ? '/' : `/${page}`
    cy.location('pathname').should('equal', expectedPath)
    cy.dataCy(`page-content-${page}`).should('exist')
    cy.dataCy('loading-progress').should('not.be.visible')
    return cy
  },
)

Cypress.Commands.add(
  'createPerson',
  (data: Partial<PersonItem>): Cypress.Chainable => {
    cy.page('people')
    cy.dataCy('fab').click()
    Object.entries(data).forEach(([key, value]) => {
      if (key.includes('Frequency') && value !== undefined) {
        cy.dataCy(key).click()
        cy.dataCy(`frequency-${value}`).click()
      } else if (value !== undefined) {
        cy.dataCy(key).clear().type(String(value))
      }
    })
    return cy
  },
)

Cypress.Commands.add(
  'createGroup',
  (data: Partial<GroupItem>): Cypress.Chainable => {
    cy.page('groups')
    cy.dataCy('fab').click()
    Object.entries(data).forEach(([key, value]) => {
      if (key.includes('Frequency') && value !== undefined) {
        cy.dataCy(key).click()
        cy.dataCy(`frequency-${value}`).click()
      } else if (value !== undefined) {
        cy.dataCy(key).clear().type(String(value))
      }
    })
    return cy
  },
)

Cypress.Commands.add(
  'addToGroup',
  (group: string): Cypress.Chainable => {
    cy.dataCy('groups').type(`${group}{enter}`)
    cy.get('body').type('{esc}')
    return cy
  },
)

Cypress.Commands.add(
  'addMember',
  (name: string): Cypress.Chainable => {
    cy.dataCy('members').type(`${name}{enter}`)
    cy.get('body').type('{esc}')
    return cy
  },
)

Cypress.Commands.add(
  'saveDrawer',
  (): Cypress.Chainable => {
    cy.intercept({ method: /PUT|POST/, url: '**/items/**' }).as('saveItem')
    cy.dataCy('drawer-done').last().click()
    cy.wait('@saveItem')
    return cy
  },
)
