#!/usr/bin/env bash
set -e
cd "$(dirname "$(realpath "$0")")"
tf_cmd="$1"

(
  if [[ -f "./.secrets.sh" ]]; then
    source ./.secrets.sh
  fi

  extra_args=()
  if [[ "$tf_cmd" =~ init|refresh|plan|apply ]]; then
    extra_args+=("-input=false")
  fi

  export TF_VAR_app_version="$(./version.sh app)"
  export TF_VAR_vault_version="$(./version.sh vault)"
  export TF_IN_AUTOMATION="1"

  docker-compose run \
    --rm \
    -u "$(id -u):$(id -g)" \
    terraform \
    $tf_cmd ${extra_args} ${@:2}
)
