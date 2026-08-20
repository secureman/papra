#!/bin/bash
# build-push-shutdown.sh
# Builds the arm64 papra-server image, pushes it to GHCR, then shuts the
# laptop down. Logs everything to a timestamped file so you can check what
# happened in the morning regardless of whether it succeeded or failed.

set -uo pipefail

REPO_DIR="$HOME/Downloads/Githubs/papra"
IMAGE="ghcr.io/secureman/papra-server:arm64"
LOG_FILE="$HOME/papra-build-$(date '+%Y%m%d-%H%M%S').log"
SHUTDOWN_DELAY_SECONDS=15

cd "$REPO_DIR" || { echo "Can't find $REPO_DIR"; exit 1; }

{
  echo "=== Started: $(date) ==="
  echo "Building and pushing $IMAGE"
  echo

  docker buildx build --platform linux/arm64 \
    -t "$IMAGE" \
    --provenance=false --sbom=false \
    --push .

  BUILD_STATUS=$?

  echo
  if [[ "$BUILD_STATUS" -eq 0 ]]; then
    echo "=== SUCCESS: build + push completed at $(date) ==="
  else
    echo "=== FAILED: build/push exited with status $BUILD_STATUS at $(date) ==="
  fi
} | tee "$LOG_FILE"

echo
echo "Full log saved to: $LOG_FILE"
echo "Shutting down in ${SHUTDOWN_DELAY_SECONDS}s — Ctrl+C now to cancel."
sleep "$SHUTDOWN_DELAY_SECONDS"

sudo shutdown -h now
