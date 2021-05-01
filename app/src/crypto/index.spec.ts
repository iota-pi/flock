import { Vault } from '.';
import { getAccountId } from '../utils';

describe('Vault (Crypto)', () => {
  it('encrypt and decrypt', async () => {
    const account = getAccountId();
    const vault = await Vault.create(account, 'example');
    const text = 'It came to me on my birthday, my precious.';
    const cipher = await vault.encrypt(text);
    const result = await vault.decrypt(cipher);
    expect(result).toEqual(text);
  });

  it('encryptObject and decryptObject', async () => {
    const account = getAccountId();
    const vault = await Vault.create(account, 'example');
    const obj = { id: 'onering' };
    const cipher = await vault.encryptObject(obj);
    const result = await vault.decryptObject(cipher);
    expect(result).toEqual(obj);
  });
});
