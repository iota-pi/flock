#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$(realpath "$0")")"
source .env

function stage() {
  echo -e "--- ${GREEN}${1}${NC}"
}

PRODUCTION="NO"
FORCE_UPDATE=""
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
    *)
      shift
      ;;
  esac
done
export FORCE_UPDATE

GREEN="\033[0;32m"
NC="\033[0m"
stage "Running tests"
./run-all-tests.sh

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
