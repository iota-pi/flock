/// <reference types="cypress" />
import type { GroupItem, PersonItem } from '../../src/state/items'
import type { PageId } from '../../src/components/pages/types'

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
      page(page: PageId): Chainable

      createPerson(data: Partial<PersonItem>, manual?: boolean): Chainable
      createGroup(data: Partial<GroupItem>, manual?: boolean): Chainable
      saveDrawer(): Chainable

      addToGroup(group: string): Chainable
      addMember(name: string): Chainable
    }
  }
}

import './commands'

const TEST_PASSWORD = 'TestPass123!'

const establishSession = () => {
  cy.ensureAccount(TEST_PASSWORD).then(() => {
    cy.page('prayer')

    // Ensure axios has been initialised (initAxios called during login)
    cy.window().should(win => {
      expect(win.checkAxios && win.checkAxios()).to.eq(true)
    })
  })
}

beforeEach(() => {
  cy.session('TEST_SESSION', establishSession, { cacheAcrossSpecs: true })
  cy.visit('/')
})

Cypress.Keyboard.defaults({ keystrokeDelay: 5 })
