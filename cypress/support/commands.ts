import type { PageId } from '../../src/components/pages/types'
import {
  getBlankGroup,
  getBlankPerson,
  type GroupItem,
  type PersonItem,
} from '../../src/state/items'


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
  (page: PageId): Cypress.Chainable => {
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
  (data: Partial<PersonItem>, manual = false): Cypress.Chainable => {
    if (manual) {
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
    } else {
      return cy.window().then(win => {
        return win.mutations.then(mutations => {
          const person = {
            ...getBlankPerson(undefined, false),
            ...data,
          }
          return mutations.mutateStoreItems(person)
        })
      })
    }
  },
)

Cypress.Commands.add(
  'createGroup',
  (data: Partial<GroupItem>, manual = false): Cypress.Chainable => {
    if (manual) {
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
    } else {
      return cy.window().then(win => {
        return win.mutations.then(mutations => {
          const group = {
            ...getBlankGroup(undefined, false),
            ...data,
          }
          return mutations.mutateStoreItems(group)
        })
      })
    }
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
    return cy.dataCy('drawer-done').last().then($button => {
      const shouldWait = $button.text().toLowerCase().includes('save')

      if (shouldWait) {
        cy.intercept({ method: /PUT|POST/, url: '**/items/**' }).as('saveItem')
      }

      cy.wrap($button).click()

      if (shouldWait) {
        cy.wait('@saveItem')
      }

      return cy
    })
  },
)

Cypress.Commands.add(
  'invalidateQuery',
  (key: AppQueryKey): Cypress.Chainable => {
    return cy.window({ log: false }).then(win => {
      if (!win.invalidateQuery) {
        throw new Error('invalidateQuery function not found on window object')
      }
      return win.invalidateQuery(key)
    })
  },
)
