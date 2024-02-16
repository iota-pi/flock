#!/usr/bin/env bash
set -euo pipefail

./node_modules/.bin/esbuild \
  index.ts \
  --outfile=dist/bundled/lambda.js \
  --bundle \
  --minify \
  --platform=node \
  --target=node14 \
  --external:aws-sdk
# cp ./gcp-service-credentials.json dist/bundled/
(
  cd dist/bundled
  zip -r ../lambda.zip .
)
