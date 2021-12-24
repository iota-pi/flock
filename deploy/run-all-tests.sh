#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."

docker-compose up -d api
export CI=true
(
  cd app
  yarn test

  if grep -qe 'it\.only(' cypress/integration/*.spec.ts; then
    >&2 echo 'Cannot deploy; it.only() was found in Cypress tests'
    exit 1
  fi

  yarn build
  port=8080
  yarn run serve build -p ${port} >/dev/null 2>&1 &
  server=$!
  yarn run cypress run --config "baseUrl=http://localhost:${port}"
  kill $! >/dev/null 2>&1 || true
)
(
  cd vault
  yarn docker:test
)
