#!/usr/bin/env bash
set -e
cd "$(dirname "$(realpath "$0")")"
tf_cmd="$1"

extra_args=()
if [[ "$tf_cmd" =~ init|refresh|plan|apply ]]; then
  extra_args+=("-input=false")
fi

docker compose run \
  --rm \
  -e TF_VAR_vault_version="$(./version.sh vault)" \
  -e TF_IN_AUTOMATION="1" \
  -u "$(id -u):$(id -g)" \
  terraform \
  terraform \
  $tf_cmd ${extra_args} ${@:2}
