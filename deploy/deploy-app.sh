#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
source .env

outputs="$(./tf.sh output -json)"
environment=$(echo "$outputs" | jq -r ".environment.value")
app_bucket=$(echo "$outputs" | jq -r ".app_bucket.value")
vault_endpoint=$(echo "$outputs" | jq -r ".vault_endpoint.value")

if [[ -z $app_bucket || $app_bucket == null ]]; then
  echo "App bucket has not been deployed yet. Skipping building app."
  exit 0
fi

# Check versions to see if we need to re-build and re-deploy
version=$(./version.sh app)
s3_version_file="s3://$app_bucket/versions/$version"
existing_files=$(aws s3 ls $s3_version_file || true)
if [[ -n $existing_files && -z ${FORCE_UPDATE:-} ]]; then
  echo "No changes to app, skipping build and deploy."
  echo "Set the FORCE_UPDATE env variable to force an update."
  echo "Already built version is: $version"
  exit 0
fi

environment_hyphens=$(echo $environment | sed 's/./-/g')
echo "Deploying app to $environment"
echo "-----------------$environment_hyphens"
REACT_APP_BASE_URL="$APP_NAME.cross-code.org"
if [[ $environment != "production" ]]; then
  REACT_APP_BASE_URL="$environment.$REACT_APP_BASE_URL"
fi
export REACT_APP_BASE_URL
export REACT_APP_VAULT_ENDPOINT="$vault_endpoint"

max_age=0
if [[ $environment == production ]]; then
  max_age=7200
fi

cd ../app
yarn build

key_base="s3://$app_bucket"
s3_app_params="--acl public-read --cache-control max-age=$max_age"

echo "Copying to $key_base/"
aws s3 cp build/ "$key_base/" --recursive $s3_app_params

echo "Creating version marker at s3://$app_bucket/versions/$version"
touch version
aws s3 cp version "s3://$app_bucket/versions/$version"
rm version

echo "Finished deployment for version $version"
