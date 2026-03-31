/// <reference types="cypress" />
import 'cypress-axe'
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

      goOffline(): Chainable
      goOnline(): Chainable
      forceServerError(): Chainable
      getOfflineQueue(): Chainable<unknown[]>
      getDeadLetterQueue(): Chainable<unknown[]>

      ensureAccount(password: string): Chainable<string>

      createAccount(password: string): Chainable
      login(credentials: { username: string, password: string }): Chainable
      page(page: PageId): Chainable

      createPerson(data: Partial<PersonItem>, manual?: boolean): Chainable
      createGroup(data: Partial<GroupItem>, manual?: boolean): Chainable
      saveDrawer(): Chainable

      addToGroup(group: string): Chainable
      addMember(name: string): Chainable

      invalidateQuery(key: string): Chainable
    }
  }
}

import './commands'

Cypress.Commands.overwrite(
  'checkA11y',
  (originalFn, context?, options?) => originalFn(context, {
    includedImpacts: ['critical'],
    ...(options || {}),
  }, violations => {
    const details = violations
      .map(violation => `${violation.id}(${violation.impact}):${violation.nodes.length}`)
      .join(', ')

    expect(violations, details).to.have.length(0)
  }),
)

const TEST_PASSWORD = 'TestPass123!'
const SESSION_KEY = `TEST_SESSION_${Date.now()}`

const establishSession = () => {
  Cypress.env('TEST_ACCOUNT_ID', '')

  cy.ensureAccount(TEST_PASSWORD).then(() => {
    cy.page('prayer')

    // Ensure auth token has been initialised during login
    cy.window().should(win => {
      expect(win.hasApiAuthToken && win.hasApiAuthToken()).to.eq(true)
    })
  })
}

beforeEach(() => {
  cy.session(SESSION_KEY, establishSession, { cacheAcrossSpecs: true })
  cy.visit('/')
  cy.injectAxe()
})

Cypress.Keyboard.defaults({ keystrokeDelay: 5 })
