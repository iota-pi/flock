#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."

export CI=true
(
  cd app
  yarn test

  DISABLE_ESLINT_PLUGIN=true BROWSER=none yarn start >/dev/null 2>&1 &
  server=$!
  yarn run cypress run
  kill $! >/dev/null 2>&1 || true
)
(
  cd vault
  # yarn test
)
