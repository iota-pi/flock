#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
source .env

GREEN="\033[0;32m"
NC="\033[0m"
function stage() {
  echo -e "--- ${GREEN}${1}${NC}"
}

PRODUCTION="NO"
FORCE_UPDATE=""
SKIP_TESTS="NO"
while [[ ${#} -gt 0 ]]
do
  case "${1}" in
    --prod)
      PRODUCTION="YES"
      shift
      ;;
    -f|--force)
      FORCE_UPDATE="YES"
      shift
      ;;
    -T|--no-tests)
      SKIP_TESTS="YES"
      shift
      ;;
    *)
      shift
      ;;
  esac
done
export FORCE_UPDATE

if [[ "${SKIP_TESTS}" = "YES" && "${PRODUCTION}" = "YES" ]]; then
  2>&1 echo "Cannot skip tests while deploying to production"
  exit 1
fi

(
  if [[ -f "./.secrets.sh" ]]; then
    source ./.secrets.sh
  fi
  docker compose up -d
)

stage "Running tests"
if [[ "${SKIP_TESTS}" != "YES" ]]; then
  ./run-all-tests.sh
else
  echo "Skipping tests"
fi

stage "Setting workspace"
current_workspace="$(./tf.sh workspace show)"
if [[ "${PRODUCTION}" != "YES" ]]; then
  if [[ "${current_workspace}" != "staging" ]]; then
    ./tf.sh workspace select staging
  fi
else
  if [[ "${current_workspace}" != "default" ]]; then
    ./tf.sh workspace select default
  fi
fi

stage "Terraform Apply"
./tf.sh apply

stage "Getting deployment info"
outputs="$(./tf.sh output -json)"
environment=$(echo "$outputs" | jq -r ".environment.value")
app_bucket=$(echo "$outputs" | jq -r ".app_bucket.value")
vault_endpoint=$(echo "$outputs" | jq -r ".vault_endpoint.value")

if [[ $environment == "production" ]]; then
  export VITE_BASE_URL="flock.cross-code.org"
  export CACHE_MAX_AGE=7200
else
  export VITE_BASE_URL="$environment.flock.cross-code.org"
  export CACHE_MAX_AGE=0
fi
export VITE_VAULT_ENDPOINT="$vault_endpoint"
export APP_BUCKET="$app_bucket"

stage "Building App"
cd ..
yarn build

stage "Deploying App to S3"
yarn deploy:app

echo "Finished deployment to $environment"
