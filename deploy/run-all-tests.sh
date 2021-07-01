#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")/.."

export CI=1
(
  cd app
  yarn test
)
(
  cd vault
  # yarn test
)
