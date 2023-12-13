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

stage "Building Vault API"
./deploy-vault.sh

stage "Building App"
./deploy-app.sh

stage "Terraform Apply"
./tf.sh apply
