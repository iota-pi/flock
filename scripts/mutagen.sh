mutagen sync create \
  --name=flock-sync \
  --ignore="node_modules,.sst,.git,.yarn/cache" \
  --sync-mode=two-way-resolved \
  /mnt/c/Users/$USER/projects/flock \
  .
