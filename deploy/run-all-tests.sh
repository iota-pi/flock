#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."

export CI=true
(
  cd app
  yarn test

  if grep -qe 'it\.only(' cypress/integration/*.spec.ts; then
    >&2 echo 'Cannot deploy; it.only() was found in Cypress tests'
    exit 1
  fi

  DISABLE_ESLINT_PLUGIN=true BROWSER=none yarn start >/dev/null 2>&1 &
  server=$!
  yarn run cypress run
  kill $! >/dev/null 2>&1 || true
)
(
  cd vault
  # yarn test
)
