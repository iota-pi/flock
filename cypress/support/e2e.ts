/// <reference types="cypress" />
import 'cypress-axe'
import type { ProtectedPageId } from '../../src/components/pages/types'
import type { GroupItem, PersonItem } from '../../src/shared/schemas/items'

Cypress.on('window:before:load', (win) => {
  cy.spy(win.console, 'log').as('consoleLog')
  cy.spy(win.console, 'error').as('consoleError')

  // Forward to Cypress console (Node) so it shows in terminal
  const originalLog = win.console.log
  win.console.log = (...args) => {
    Cypress.log({ name: 'console.log', message: args })
    originalLog.apply(win.console, args)
  }
})

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
      page(page: ProtectedPageId): Chainable

      createPerson(data: Partial<PersonItem>, manual?: boolean): Chainable
      createGroup(data: Partial<GroupItem>, manual?: boolean): Chainable
      saveDrawer(): Chainable

      addToGroup(group: string): Chainable
      addMember(name: string): Chainable
    }
  }
}

import './commands'

Cypress.Commands.overwrite(
  'checkA11y',
  (originalFn, context?, options?) => {
    const mergedOptions = {
      includedImpacts: ['critical'],
      ...(options || {}),
    }

    const assertViolations = (violations: Array<{ id: string; impact?: string | null; nodes: Array<{ html: string; target: string[] }> }>) => {
      const details = violations
        .map(violation => `${violation.id}(${violation.impact}): ${violation.nodes.map(n => `${n.target.join(' ')} [${n.html}]`).join(', ')}`)
        .join('; ')

      expect(violations, details).to.have.length(0)
    }

    if (typeof context === 'string') {
      return cy.get('body').then($body => {
        if ($body.find(context).length === 0) {
          return originalFn(undefined, mergedOptions, assertViolations)
        }

        return originalFn(context, mergedOptions, assertViolations)
      })
    }

    return originalFn(context, mergedOptions, assertViolations)
  },
)

const TEST_PASSWORD = 'TestPass123!'

const establishSession = () => {
  cy.ensureAccount(TEST_PASSWORD).then(() => {
    // Pre-warm dynamic imports that tests depend on.
    // Vite can take several seconds to compile these on the first test run,
    // which causes cy.then() timeouts if we don't wait for them here.
    cy.window({ timeout: 30000 }).then({ timeout: 30000 }, (win) => {
      return Promise.all([
        win.mutations,
        win.appStore,
        win.vault
      ])
    }).then(() => {
      // Wait for SyncBridge to complete its background initialization
      // so we don't time out the individual test's cy.then() calls later
      return cy.window({ timeout: 30000 }).then({ timeout: 30000 }, (win: any) => {
        if (win.syncBridge) {
          return win.syncBridge.then((bridge: any) => bridge.ensureReady())
        }
      })
    }).then(() => {
      cy.page('prayer')
    })

    // Ensure auth token has been initialised during login
    cy.window().should(win => {
      expect(win.hasApiAuthToken && win.hasApiAuthToken()).to.eq(true)
    })
  })
}

beforeEach(() => {
  establishSession()
  cy.injectAxe()
})

Cypress.Keyboard.defaults({ keystrokeDelay: 5 })

Cypress.on('window:before:load', (win) => {
  const originalConsoleError = win.console.error
  win.console.error = (...args: unknown[]) => {
    originalConsoleError.apply(win.console, args)
    const msg = args.map(a => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a))).join(' ')
    if (
      msg.includes('RangeError') ||
      msg.includes('recursive use of an object') ||
      msg.includes('[Sync Worker Uncaught Error]')
    ) {
      throw new Error(`[Cypress E2E Error Assert] Severe background/Automerge error detected: ${msg}`)
    }
  }
})
