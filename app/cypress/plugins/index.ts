import path from 'path';

const plugins: Cypress.PluginConfig = on => {
  // on('before:browser:launch', (browser, launchOptions) => {
  //   const downloadDirectory = path.join(__dirname, '..', 'downloads');
  //   if (browser.family === 'chromium') {
  //     launchOptions.preferences.default['download'] = {
  //       default_directory: downloadDirectory
  //     };
  //   }
  //   return launchOptions;
  // });
};
export default plugins;
