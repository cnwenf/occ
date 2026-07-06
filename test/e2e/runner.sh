#!/usr/bin/env bash
# Start a PERSISTENT e2e runner container. Stays up (tail -f /dev/null) so you
# can `docker exec` into it to run/re-run the tmux-based interactive REPL tests
# repeatedly without rebuilding the image each time.
#
# Image: occ-e2e:latest (built from test/e2e/Dockerfile; includes tmux).
# Repo is baked into the image at /occ with dist/cli.js prebuilt.
# test/e2e is mounted read-only at /test/e2e so test edits need no rebuild.
# Model config is forwarded from the host env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_TAG="occ-e2e:latest"
CONTAINER="occ-e2e-runner"

: "${ANTHROPIC_BASE_URL:?ANTHROPIC_BASE_URL must be set on the host}"
: "${ANTHROPIC_AUTH_TOKEN:?ANTHROPIC_AUTH_TOKEN must be set on the host}"
: "${ANTHROPIC_MODEL:?ANTHROPIC_MODEL must be set on the host}"

# 1. Build image (cached; rebuilds only on source/Dockerfile change).
docker build -q -t "$IMAGE_TAG" -f "$ROOT/test/e2e/Dockerfile" "$ROOT"

# 2. Replace any existing runner container.
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# 3. Run detached, creds forwarded, test dir mounted RO, stay alive.
#    --user occ: non-root so the REPL tests can boot the CLI with
#    --dangerously-skip-permissions (refused for root).
docker run -d --name "$CONTAINER" --user occ \
  -e HOME=/home/occ \
  -e ANTHROPIC_BASE_URL \
  -e ANTHROPIC_AUTH_TOKEN \
  -e ANTHROPIC_MODEL \
  -e ANTHROPIC_DEFAULT_HAIKU_MODEL \
  -e ANTHROPIC_DEFAULT_SONNET_MODEL \
  -e ANTHROPIC_DEFAULT_OPUS_MODEL \
  -v "$ROOT/test/e2e:/test/e2e:ro" \
  -w /occ \
  "$IMAGE_TAG" \
  tail -f /dev/null

echo "Persistent runner '$CONTAINER' is up."
echo "  Run REPL test: docker exec $CONTAINER bash -lc 'bun test /test/e2e/repl-interactive.e2e.test.ts'"
echo "  Run all e2e:   docker exec $CONTAINER bash -lc 'bun test /test/e2e'"
echo "  Shell:         docker exec -it $CONTAINER bash"
echo "  Stop:          docker rm -f $CONTAINER"
