#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."

docker compose up -d api
export CI=true
(
  cd app
  yarn test

  # if grep -qe 'it\.only(' cypress/e2e/*.cy.ts; then
  #   >&2 echo 'Cannot deploy; it.only() was found in Cypress tests'
  #   exit 1
  # fi

  # yarn build
  # yarn serve &
  # yarn cypress run
  # kill $! >/dev/null 2>&1 || true
)
(
  cd vault
  yarn docker:test
)
