#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
source .env

outputs="$(./tf.sh output -json)"
environment=$(echo "$outputs" | jq -r ".environment.value")
code_bucket="crosscode-lambdas"
version="$(./version.sh vault)"

dest="s3://$code_bucket/$APP_NAME/$environment/$version"
existing_files=$(aws s3 ls "$dest/" || true)
if [[ -n $existing_files && -z ${FORCE_UPDATE:-} ]]; then
  echo "No changes to lambda, skipping build and deploy."
  echo "Set the FORCE_UPDATE env variable to force an update."
  echo "Already built version is: $version"
  exit
fi

(
  cd ../vault
  yarn build
  aws s3 cp "dist/lambda.zip" "$dest/vault.zip"
)
