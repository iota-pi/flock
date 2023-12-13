import Vault from '../../api/Vault';
import { getBlankPerson, PersonItem } from '../../state/items';
import { MaturityControl, updateMaturityForPeople } from './MaturityDialog';

it('updateMaturityForPeople', () => {
  const vault = { store: jest.fn() };
  const people: PersonItem[] = [
    { ...getBlankPerson(), firstName: 'Frodo', maturity: 'Youngster' },
    { ...getBlankPerson(), firstName: 'Bilbo', maturity: 'Very old' },
    { ...getBlankPerson(), firstName: 'Merry', maturity: 'Youngster' },
    { ...getBlankPerson(), firstName: 'Gandalf', maturity: 'Ancient' },
  ];
  const original: MaturityControl[] = [
    { id: 'a', name: 'Youngster' },
    { id: 'b', name: 'Very old' },
    { id: 'c', name: 'Ancient' },
  ];
  const updated: MaturityControl[] = [
    { id: 'a', name: 'Noob' },
    { id: 'b', name: 'Very old' },
    { id: 'c', name: 'Wizard' },
  ];
  updateMaturityForPeople(vault as unknown as Vault, people, original, updated);
  expect(vault.store).toHaveBeenCalledTimes(1);
  const updatedPeople: PersonItem[] = vault.store.mock.calls[0][0];
  expect(updatedPeople.map(person => person.firstName)).toEqual(['Frodo', 'Merry', 'Gandalf']);
  expect(updatedPeople.map(person => person.maturity)).toEqual(['Noob', 'Noob', 'Wizard']);
});
