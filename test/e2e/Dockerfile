# E2E test image for OCC — clean Ubuntu + Bun + the built OCC CLI.
# Built once by run.sh; e2e test scripts run inside this container against the
# real model endpoint (config injected via env at `docker run` time).
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

# Bun requires unzip + ca-certificates; git for any MCP/plugin git scenarios.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl unzip git \
    && rm -rf /var/lib/apt/lists/*

# Install Bun >= 1.3.11 (OCC requirement).
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.14" \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

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

# Default to a shell so `docker run <img> bash -lc '...'` works for the runner.
CMD ["/bin/bash"]
