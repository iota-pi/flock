import { defineConfig } from 'cypress'
import path from 'path'
import fs from 'fs'

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:3000',
    video: false,
    // retries: 1,
    viewportWidth: 1280,
    viewportHeight: 720,
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    experimentalRunAllSpecs: true,
    setupNodeEvents(on, config) {
      const downloads = path.join(__dirname, 'cypress', 'downloads')
      if (fs.existsSync(downloads)) {
        fs.rmSync(downloads, { recursive: true, force: true })
      }

      on('after:run', () => {
        if (fs.existsSync(downloads)) {
          fs.rmSync(downloads, { recursive: true, force: true })
        }
      })
      return config
    },
  },
})
