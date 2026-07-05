#!/usr/bin/env bash
# Build the OCC e2e Docker image and run the e2e test suite inside it.
# Model config (URL / token / model id) is forwarded from the host env so the
# containerized OCC talks to the same endpoint the host uses.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="occ-e2e:latest"

# --- 1. Build the image (cached after first run) --------------------------------
docker build -q -t "$IMAGE_TAG" -f "$ROOT/test/e2e/Dockerfile" "$ROOT"

# --- 2. Forward model config into the container ---------------------------------
ENV_FILE="$(mktemp)"
trap 'rm -f "$ENV_FILE"' EXIT
: > "$ENV_FILE"
printenv_env() {
  : "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL must be set on the host}"
  : "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN must be set on the host}"
  : "${ANTHROPIC_MODEL:?ANTHROPIC_MODEL must be set on the host}"
}
printenv_env

# --- 3. Run the e2e suite -------------------------------------------------------
# Host test/e2e is mounted read-only so edits don't need a rebuild. The OCC
# repo itself is baked into the image (rebuilt only when source changes).
docker run --rm \
  -e ANTHROPIC_BASE_URL \
  -e ANTHROPIC_AUTH_TOKEN \
  -e ANTHROPIC_MODEL \
  -e ANTHROPIC_DEFAULT_HAIKU_MODEL \
  -e ANTHROPIC_DEFAULT_SONNET_MODEL \
  -e ANTHROPIC_DEFAULT_OPUS_MODEL \
  -v "$ROOT/test/e2e:/test/e2e:ro" \
  -w /occ \
  "$IMAGE_TAG" \
  bash -lc 'bun test /test/e2e'
