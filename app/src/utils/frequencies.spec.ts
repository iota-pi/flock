import { Due, Frequency, isDue, ONE_DAY } from './frequencies';

test.each([
  [new Date(), 'daily' as Frequency, Due.fine],
  [new Date('2000-01-01'), 'daily' as Frequency, Due.overdue],
  [new Date('2000-01-01'), 'none' as Frequency, Due.fine],
  [new Date(new Date().getTime() - ONE_DAY), 'daily' as Frequency, Due.due],
  [new Date(new Date().getTime() - ONE_DAY), 'weekly' as Frequency, Due.fine],
])('isDue(%s, "%s") = %s', (lastDate, frequency, expected) => {
  const result = isDue(lastDate, frequency);
  expect(result).toEqual(expected);
});
