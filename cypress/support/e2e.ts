/// <reference types="cypress" />
import type { GroupItem, PersonItem } from '../../src/state/items'

declare global {
  namespace Cypress {
    interface Chainable {
      /**
       * Custom command to select DOM element(s) by data-cy attribute.
       * Accepts one or more ids.
       * @example cy.dataCy('greeting')
       */
      dataCy(...value: string[]): Chainable<JQuery<HTMLElement>>

      ensureAccount(password: string): Chainable<string>

      createAccount(password: string): Chainable
      login(credentials: { username: string, password: string }): Chainable
      page(page: string): Chainable

      createPerson(data: Partial<PersonItem>): Chainable
      createGroup(data: Partial<GroupItem>): Chainable
      saveDrawer(): Chainable

      addToGroup(group: string): Chainable
      addMember(name: string): Chainable
    }
  }
}

import './commands'

const TEST_PASSWORD = 'TestPass123!'

const establishSession = () => {
  cy.ensureAccount(TEST_PASSWORD).then(accountId => {
    cy.intercept({ method: 'GET', url: `**/${accountId}` }).as('loadMetadata')
    cy.intercept({ method: 'GET', url: `**/${accountId}/items**` }).as('loadItems')

    cy.visit('/')

    cy.wait(['@loadMetadata', '@loadItems'])
  })
}

beforeEach(() => {
  cy.session('TEST_SESSION', establishSession, { cacheAcrossSpecs: true })
  cy.visit('/')
})

Cypress.Keyboard.defaults({ keystrokeDelay: 5 })
