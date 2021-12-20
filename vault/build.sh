#!/usr/bin/env bash
set -euo pipefail

./node_modules/.bin/tsc
./node_modules/.bin/webpack
cp ./gcp-service-credentials.json build/bundled/
(cd build/bundled; zip -r ../lambda.zip .)
