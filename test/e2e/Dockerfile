# E2E test image for OCC — clean Ubuntu + Bun + the built OCC CLI.
# Built once by run.sh; e2e test scripts run inside this container against the
# real model endpoint (config injected via env at `docker run` time).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Bun requires unzip + ca-certificates; git for any MCP/plugin git scenarios.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip git tmux \
    && rm -rf /var/lib/apt/lists/*

# Install Bun >= 1.3.11 (OCC requirement). Install to /opt/bun (world-executable)
# so the non-root `occ` runner user can execute it — /root/.bun is root-only.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash -s "bun-v1.3.14" \
    && chmod -R a+rX /opt/bun \
    && ln -sf /opt/bun/bin/bun /usr/local/bin/bun

WORKDIR /occ

# Copy the repo (respect .dockerignore). node_modules + dist are rebuilt inside.
COPY . /occ

# --ignore-scripts: the `prepare` script sets a git hooks path which fails
# without .git (excluded from the image). Native deps are stubs (pure JS).
RUN bun install --ignore-scripts \
    && bun build src/entrypoints/cli.tsx --outdir dist --target bun

# The occ entrypoint: the built artifact (no run-time transpilation, avoids
# bun transpiler-cache lock when `bun test` spawns the CLI as a child).
ENV OCC_ENTRYPOINT="/occ/dist/cli.js"

# Non-root user for the persistent REPL runner. --dangerously-skip-permissions
# is refused for root, so the tmux REPL tests (which boot the CLI with that
# flag) must run as a non-root user. Default USER is left unset so the one-shot
# run.sh flow still runs as root (unchanged); runner.sh opts in via --user occ.
#
# Pre-seed the occ user's config so a fresh REPL boots straight to a bypass-mode
# prompt — skipping first-run onboarding (theme picker, security notes, trust
# dialog) and the per-boot "Bypass Permissions mode" acceptance dialog (gated on
# settings.json skipDangerousModePermissionPrompt). Without this, the REPL tests
# stall on interactive onboarding dialogs. Seed lives in test/e2e/seed/.
RUN groupadd -r occ && useradd -r -g occ -m -d /home/occ -s /bin/bash occ \
    && mkdir -p /home/occ/.claude \
    && cp /occ/test/e2e/seed/.claude.json /home/occ/.claude.json \
    && cp /occ/test/e2e/seed/.claude/settings.json /home/occ/.claude/settings.json \
    && chown -R occ:occ /home/occ

# Default to a shell so `docker run <img> bash -lc '...'` works for the runner.
CMD ["/bin/bash"]
