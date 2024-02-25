import * as vault from '../api/Vault'
import { setAccount } from '../state/account'
import { getBlankPerson, PersonItem } from '../state/items'
import store from '../store'
import { MaturityControl, updateMaturityForPeople } from './maturity'

describe('MaturityControl', () => {
  beforeAll(
    async () => {
      store.dispatch(setAccount({ account: '.' }))
      await vault.initialiseVault(
        'example',
        true,
        100,
      )
    },
    10000,
  )

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('updateMaturityForPeople', async () => {
    const spy = jest.spyOn(vault, 'storeItems').mockImplementation(() => Promise.resolve())
    const people: PersonItem[] = [
      { ...getBlankPerson(), name: 'Frodo', maturity: 'Youngster' },
      { ...getBlankPerson(), name: 'Bilbo', maturity: 'Very old' },
      { ...getBlankPerson(), name: 'Merry', maturity: 'Youngster' },
      { ...getBlankPerson(), name: 'Gandalf', maturity: 'Ancient' },
    ]
    const original: MaturityControl[] = [
      { id: 'a', name: 'Youngster' },
      { id: 'b', name: 'Very old' },
      { id: 'c', name: 'Ancient' },
    ]
    const updated: MaturityControl[] = [
      { id: 'a', name: 'Noob' },
      { id: 'b', name: 'Very old' },
      { id: 'c', name: 'Wizard' },
    ]
    await updateMaturityForPeople(people, original, updated)
    expect(vault.storeItems).toHaveBeenCalledTimes(1)
    const updatedPeople = spy.mock.calls[0][0] as PersonItem[]
    expect(updatedPeople.map(person => person.name)).toEqual(['Frodo', 'Merry', 'Gandalf'])
    expect(updatedPeople.map(person => person.maturity)).toEqual(['Noob', 'Noob', 'Wizard'])
  })
})
