import { createApp } from 'vue';
import App from './App.vue';
import { Vault } from './crypto';
import router from './router';
import store from './store';
import { getAccountId, getIndividualId } from './utils';
import { Individual } from './utils/interfaces';

createApp(App).use(store).use(router).mount('#app');

async function testVault() {
  const account = getAccountId();
  const i: Individual = { id: getIndividualId() };
  const vault = await Vault.create(account, 'example');
  await vault.store(i);
  const result = await vault.fetch(i.id);
  console.log(result, i, result === i);
}

testVault();
